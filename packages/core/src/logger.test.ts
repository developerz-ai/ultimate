import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:process`, and unavoidable: `LOG_LEVEL` is read from this process's own environment, so
// proving the threshold it sets means writing that exact binding.
import process from 'node:process';
import { type Clock, frozenClock } from './clock';
import { ERROR_DOCS_URL } from './error-codes';
import { UltimateError } from './errors';
import type { LogLevel } from './logger';
import { LOG_LEVELS, REDACTED, structuredLogger } from './logger';

function capture(level: 'trace' | 'info' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = structuredLogger({
    level,
    clock: frozenClock('2026-07-26T10:00:00.000Z'),
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('logger', () => {
  test('emits one JSON line with ts, level and msg', () => {
    const { logger, lines } = capture();
    logger.info('post published', { postId: 'p1' });
    expect(lines[0]).toEqual({
      ts: '2026-07-26T10:00:00.000Z',
      level: 'info',
      msg: 'post published',
      postId: 'p1',
    });
  });

  test("a caller field cannot overwrite the line's own ts, level or msg", () => {
    // Spread after them, `{ level: 'debug' }` turned an `error` line into a `debug` one — which a
    // level-filtered alert then never saw. The caller's value survives under `field.<key>`.
    const { logger, lines } = capture();
    logger.error('charge failed', { level: 'debug', msg: 'spoofed', ts: 'then', orderId: 'o1' });
    expect(lines[0]).toEqual({
      ts: '2026-07-26T10:00:00.000Z',
      level: 'error',
      msg: 'charge failed',
      'field.level': 'debug',
      'field.msg': 'spoofed',
      'field.ts': 'then',
      orderId: 'o1',
    });
    const child = logger.child({ level: 'trace' });
    child.warn('bound too');
    expect(lines[1]?.['level']).toBe('warn');
    expect(lines[1]?.['field.level']).toBe('trace');
  });

  test('emits the line even when the clock cannot say when', () => {
    // `clock.now().toISOString()` sat outside every guard the rest of this file was made total
    // for: an invalid `Date` raises `RangeError`, and a log line must never replace the event it
    // describes — `lifecycle.ts` logs the value a shutdown hook threw, so a throw here means
    // SIGTERM hangs.
    const lines: Record<string, unknown>[] = [];
    const logger = structuredLogger({
      level: 'info',
      clock: frozenClock('not-a-date'),
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    logger.info('post published', { postId: 'p1' });
    expect(lines[0]).toEqual({
      ts: 'an invalid Date',
      level: 'info',
      msg: 'post published',
      postId: 'p1',
    });
  });

  test('survives a clock that throws, or answers something that is not a Date', () => {
    const lines: Record<string, unknown>[] = [];
    const hostile: Clock = {
      now: () => {
        throw new Error('the clock is gone');
      },
      monotonic: () => 0,
    };
    const logger = structuredLogger({
      level: 'info',
      clock: hostile,
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    logger.error('drain hook threw');
    expect(lines[0]).toEqual({ ts: 'an invalid Date', level: 'error', msg: 'drain hook threw' });

    const notADate = { now: () => 0, monotonic: () => 0 } as unknown as Clock;
    const second = structuredLogger({
      level: 'info',
      clock: notADate,
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    second.error('still a line');
    expect(lines[1]).toEqual({ ts: 'an invalid Date', level: 'error', msg: 'still a line' });
  });

  test('filters below the threshold', () => {
    const { logger, lines } = capture();
    logger.debug('noise');
    logger.warn('signal');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('warn');
  });

  // The threshold is the one read in this file that decided what a process DISCLOSES, and it
  // failed open: `LEVEL_WEIGHT[level]` on a level nothing checked is `undefined`, every
  // `weight < undefined` is false, and the logger emitted every line at every level — a `trace`
  // stream out of a production process, from one typo in a config file. A level is typed and
  // arrives untyped: `app.config.ts`, a JSON file, `LOG_LEVEL`'s neighbour on the command line.
  test('a level that is not a level is refused, never a logger that emits everything', () => {
    const lines: string[] = [];
    const build = (): unknown =>
      structuredLogger({
        level: 'verbose' as LogLevel,
        writer: (line) => lines.push(line),
      });

    expect(build).toThrow(expect.objectContaining({ code: 'X_INVARIANT' }));
    // Observed before the guard: a logger, and `logger.trace('...')` writing a line.
    expect(lines).toEqual([]);
  });

  // The same typo through the OTHER door. `LOG_LEVEL=verbose` fell back to `info` in silence, so
  // an operator who asked for more got less and nothing said so, while `structuredLogger({ level })`
  // refused the identical value.
  describe('LOG_LEVEL', () => {
    const previous = process.env['LOG_LEVEL'];
    afterEach(() => {
      if (previous === undefined) delete process.env['LOG_LEVEL'];
      else process.env['LOG_LEVEL'] = previous;
    });

    test.each(['verbose', 'DEBUG', ' warn'])('%p is refused, naming the variable', (value) => {
      process.env['LOG_LEVEL'] = value;
      try {
        structuredLogger();
        expect.unreachable();
      } catch (error) {
        expect((error as { code?: string }).code).toBe('X_INVARIANT');
        expect(String((error as { fix?: string }).fix)).toContain('LOG_LEVEL=');
      }
    });

    test('a declared level is honoured, and unset or EMPTY is info', () => {
      process.env['LOG_LEVEL'] = 'warn';
      expect(structuredLogger().level).toBe('warn');
      process.env['LOG_LEVEL'] = '';
      expect(structuredLogger().level).toBe('info');
      delete process.env['LOG_LEVEL'];
      expect(structuredLogger().level).toBe('info');
    });

    test('an explicit level never reads the variable at all', () => {
      process.env['LOG_LEVEL'] = 'verbose';
      expect(structuredLogger({ level: 'error' }).level).toBe('error');
    });
  });

  test('withLevel is the same door, so a child cannot widen what the parent refused', () => {
    const { logger } = capture();
    expect(() => logger.withLevel('loud' as LogLevel)).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });

  test('every declared level still builds a logger', () => {
    for (const level of LOG_LEVELS) {
      expect(structuredLogger({ level, writer: () => undefined }).level).toBe(level);
    }
  });

  test('child fields are bound and overridable', () => {
    const { logger, lines } = capture();
    const child = logger.child({ queue: 'default', attempt: 1 });
    child.info('picked up', { attempt: 2 });
    expect(lines[0]).toMatchObject({ queue: 'default', attempt: 2 });
  });

  /**
   * A log line must never REPLACE the event it describes. `lifecycle.ts` logs the value a
   * shutdown hook threw and the value a readiness check threw — both caught, both arbitrary — so
   * a logger that throws while rendering one escapes `runPhase`'s catch, rejects the drain
   * promise, and `installSignalHandlers` never reaches `process.exit(0)`: SIGTERM hangs.
   */
  describe('a hostile field costs the field, never the line', () => {
    test('a bigint renders instead of throwing', () => {
      const { logger, lines } = capture();
      expect(() => logger.info('usage', { total: 10n, plan: 'pro' })).not.toThrow();
      expect(lines[0]).toMatchObject({ total: '10n', plan: 'pro' });
    });

    test('a throwing getter costs its own key and nothing beside it', () => {
      const { logger, lines } = capture();
      const hostile = {
        keep: 'yes',
        get boom(): never {
          throw new Error('getter');
        },
      };
      expect(() => logger.info('hook failed', { error: hostile })).not.toThrow();
      expect(lines[0]?.['error']).toEqual({ keep: 'yes', boom: 'a value that cannot be read' });
    });

    test('a value that refuses to be enumerated still leaves a line', () => {
      const { logger, lines } = capture();
      const proxy = new Proxy(
        {},
        {
          ownKeys(): never {
            throw new TypeError('ownKeys trap');
          },
        },
      );
      expect(() => logger.error('shutdown hook failed', { error: proxy })).not.toThrow();
      expect(lines[0]?.['msg']).toBe('shutdown hook failed');
    });

    test('an invalid Date does not take the line with it', () => {
      const { logger, lines } = capture();
      expect(() => logger.info('scheduled', { at: new Date('nope') })).not.toThrow();
      expect(lines[0]?.['at']).toBe('an invalid Date');
    });

    test('a top-level bigint field is still redacted by key', () => {
      const { logger, lines } = capture();
      logger.info('exchange', { token: 1n });
      expect(lines[0]?.['token']).toBe(REDACTED);
    });
  });

  test('serialises UltimateError with the --json shape', () => {
    const { logger, lines } = capture();
    logger.error('failed', {
      error: new UltimateError({ code: 'X_INTERNAL', cause: 'boom', fix: 'x verify' }),
    });
    expect(lines[0]?.['error']).toMatchObject({
      code: 'X_INTERNAL',
      cause: 'boom',
      fix: 'x verify',
      docs: ERROR_DOCS_URL,
    });
  });
});
