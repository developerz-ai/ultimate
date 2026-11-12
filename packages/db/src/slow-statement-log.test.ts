// Single responsibility: the slow-statement line — who gets one, what it carries (shape, duration,
// rows, the scope's ids) and what it never carries (a bound value), and how a burst of one shape is
// sampled down to a line per window. Events are emitted on the bus directly, as the funnel would.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  type DbStatementEvent,
  installLogSink,
  instrument,
  runWithContext,
} from '@ultimat3/core';
import { SLOW_STATEMENT_SHAPES_MAX, slowStatementLog } from './slow-statement-log';

const logged: Record<string, unknown>[] = [];
let releaseSink: () => void = () => undefined;
let off: () => void = () => undefined;
let nowMs = 0;

beforeEach(() => {
  logged.length = 0;
  nowMs = 0;
  releaseSink = installLogSink((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed['msg'] === 'db.statement.slow') logged.push(parsed);
  });
});

afterEach(() => {
  off();
  releaseSink();
});

function statement(over: Partial<DbStatementEvent> = {}): DbStatementEvent {
  return {
    text: 'select *\n  from members where email = $1',
    values: ['secret@example.com'],
    durationMs: 600,
    rows: 3,
    ...over,
  };
}

function start(thresholdMs = 500): void {
  off = slowStatementLog({ thresholdMs, now: () => nowMs });
}

describe('slowStatementLog', () => {
  test('a 600 ms statement logs once, with its shape and correlation id and no bind value', () => {
    start();
    runWithContext(ctxOf({ requestId: 'req-slow-1' }), () => {
      instrument('db.statement', statement());
    });

    expect(logged).toHaveLength(1);
    const line = logged[0] ?? {};
    expect(line['level']).toBe('warn');
    expect(line['requestId']).toBe('req-slow-1');
    expect(line['db.query.text']).toBe('select * from members where email = $1');
    expect(line['db.operation.name']).toBe('SELECT');
    expect(line['db.response.returned_rows']).toBe(3);
    expect(line['durationMs']).toBe(600);
    expect(JSON.stringify(line)).not.toContain('secret@example.com');
  });

  test('a 100 ms statement logs nothing', () => {
    start();
    instrument('db.statement', statement({ durationMs: 100 }));
    expect(logged).toHaveLength(0);
  });

  test('a burst of one shape logs once per window, and counts what it held back', () => {
    start();
    for (let i = 0; i < 50; i += 1) instrument('db.statement', statement());
    expect(logged).toHaveLength(1);

    nowMs = 9_999;
    instrument('db.statement', statement());
    expect(logged).toHaveLength(1);

    nowMs = 10_000;
    instrument('db.statement', statement());
    expect(logged).toHaveLength(2);
    expect(logged[1]?.['suppressed']).toBe(50);
  });

  test('two shapes in one window each get their line', () => {
    start();
    instrument('db.statement', statement());
    instrument('db.statement', statement({ text: 'update members set name = $1 where id = $2' }));
    expect(logged).toHaveLength(2);
  });

  test('a slow failure logs with its error type', () => {
    start();
    instrument('db.statement', statement({ rows: 0, error: new TypeError('boom') }));
    expect(logged[0]?.['error.type']).toBe('_OTHER');
  });

  test('the shape memo is bounded: past the cap the oldest shape is forgotten', () => {
    start();
    for (let i = 0; i <= SLOW_STATEMENT_SHAPES_MAX; i += 1) {
      instrument('db.statement', statement({ text: `select ${i}` }));
    }
    expect(logged).toHaveLength(SLOW_STATEMENT_SHAPES_MAX + 1);
    // `select 0` was evicted, so it logs again inside the window; the newest shape is still held.
    instrument('db.statement', statement({ text: 'select 0' }));
    instrument('db.statement', statement({ text: `select ${SLOW_STATEMENT_SHAPES_MAX}` }));
    expect(logged).toHaveLength(SLOW_STATEMENT_SHAPES_MAX + 2);
  });

  // `windowMs: NaN` (an unset env var through `Number()`) walked past `??`, and every comparison
  // against it read false: no line was ever held back, so a burst logged every statement.
  test('a windowMs that is not a number is refused, not a window that never holds anything back', () => {
    expect(() => slowStatementLog({ thresholdMs: 500, windowMs: Number.NaN })).toThrow(/windowMs/);
  });

  test('a threshold of 0 is off: nothing subscribes', () => {
    start(0);
    instrument('db.statement', statement({ durationMs: 60_000 }));
    expect(logged).toHaveLength(0);
  });

  test('the unsubscribe stops the lines', () => {
    start();
    off();
    instrument('db.statement', statement());
    expect(logged).toHaveLength(0);
  });
});
