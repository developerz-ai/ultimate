// `log.record`: the process logger's lines on the bus, redacted, never a logger with its own writer,
// and a subscriber that throws never costs the caller its `log.*` call.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { resetInstrumentation, subscribe } from './instrument';
import type { LogRecordEvent } from './instrument-events';
import { installLogSink, logger, REDACTED, structuredLogger } from './logger';

afterEach(() => resetInstrumentation());

function quiet<T>(fn: () => T): T {
  const releaseLogSink = installLogSink(() => undefined);
  try {
    return fn();
  } finally {
    releaseLogSink();
  }
}

describe('unit · log.record', () => {
  test('a process-logger line is published, fields redacted, with the clock reading', () => {
    const records: LogRecordEvent[] = [];
    subscribe('log.record', (event) => records.push(event.payload));
    quiet(() =>
      structuredLogger({ level: 'info', clock: frozenClock(1_767_225_600_000) })
        .child({ service: 'web' })
        .warn('payment.retry', { attempt: 2, password: 'hunter2' }),
    );
    expect(records).toEqual([
      {
        at: 1_767_225_600_000,
        level: 'warn',
        message: 'payment.retry',
        fields: { service: 'web', attempt: 2, password: REDACTED },
      },
    ]);
  });

  test('a line below the threshold is not published', () => {
    const records: LogRecordEvent[] = [];
    subscribe('log', (event) => records.push(event.payload));
    quiet(() => structuredLogger({ level: 'warn' }).info('not written'));
    expect(records).toEqual([]);
  });

  test('a logger with its own writer is not the process stream and is not published', () => {
    const records: LogRecordEvent[] = [];
    subscribe('log.record', (event) => records.push(event.payload));
    structuredLogger({ level: 'info', writer: () => undefined }).error('cli answer');
    expect(records).toEqual([]);
  });

  test('a throwing subscriber never reaches the log call, and the line is still written', () => {
    const lines: string[] = [];
    const bug = new RangeError('subscriber bug');
    subscribe('log.record', () => {
      throw bug;
    });
    const releaseLogSink = installLogSink((line) => lines.push(line));
    try {
      expect(() => logger.error('still written')).not.toThrow();
    } finally {
      releaseLogSink();
    }
    expect(lines.some((line) => line.includes('still written'))).toBe(true);
  });
});
