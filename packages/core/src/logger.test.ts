import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, and the browser chunk this suite builds must be written
// somewhere that is not the source tree.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform's temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive, and `Bun.write` takes a path already joined.
import { join } from 'node:path';
// `node:process`, and unavoidable: `defaultWriter` writes to this process's own stdout/stderr, so
// proving which of the two a line lands on means intercepting those exact writers.
import process from 'node:process';
import { type Clock, frozenClock } from './clock';
import { ERROR_DOCS_URL } from './error-codes';
import { UltimateError } from './errors';
import type { LogLevel } from './logger';
import { LOG_LEVELS, REDACTED, setLogSink, setLogStream, structuredLogger } from './logger';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const trackedDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(prefix);
  madeDirs.push(dir);
  return dir;
};

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

/**
 * Which stream a line with no explicit writer lands on. It is a fact about the PROCESS, not about
 * the line: a server's stdout is its log stream (12-factor), and a CLI's stdout is the answer it
 * was asked for — `x db migrate --json` wrote `ultimate migrate applied` and then the command's
 * own JSON to fd 1, so `json.load` on the output of a command whose whole contract is `--json`
 * raised on the second object.
 */
describe('logger · the sink', () => {
  test('a default-writer line goes to the sink instead of the streams, with its level', () => {
    const got: [string, string][] = [];
    const previous = setLogSink((line, level) => got.push([level, line]));
    try {
      const log = structuredLogger({
        level: 'info',
        clock: frozenClock('2026-07-26T10:00:00.000Z'),
      });
      log.debug('below the level: never written, sink or not');
      log.info('to the sink');
      log.error('errors too');
    } finally {
      // Returned so a caller restores what was there — the preload's own sink, in this process.
      expect(setLogSink(previous)).toBeDefined();
    }
    expect(got.map(([level]) => level)).toEqual(['info', 'error']);
    expect(JSON.parse(got[0]?.[1] ?? '{}')).toMatchObject({ level: 'info', msg: 'to the sink' });
  });

  test('a logger given its own writer never reaches the sink', () => {
    const sunk: string[] = [];
    const own: string[] = [];
    const previous = setLogSink((line) => sunk.push(line));
    try {
      structuredLogger({ level: 'info', writer: (line) => own.push(line) }).info('mine');
    } finally {
      setLogSink(previous);
    }
    expect(own).toHaveLength(1);
    expect(sunk).toEqual([]);
  });
});

describe('logger · the default writer', () => {
  const drive = (): { readonly out: string[]; readonly err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    // Assigned rather than spied so nothing reaches the terminal during the run.
    process.stdout.write = (chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: unknown): boolean => {
      err.push(String(chunk));
      return true;
    };
    // The streams themselves are the subject here, so the test preload's sink is lifted.
    const sink = setLogSink(undefined);
    try {
      const log = structuredLogger({
        level: 'info',
        clock: frozenClock('2026-07-26T10:00:00.000Z'),
      });
      log.info('ultimate migrate applied');
      log.error('ultimate migrate failed');
    } finally {
      setLogSink(sink);
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    return { out, err };
  };

  test('info is stdout by default, and stderr once the process redirects it', () => {
    const before = drive();
    expect(before.out.join('')).toContain('ultimate migrate applied');
    expect(before.err.join('')).toContain('ultimate migrate failed');
    try {
      setLogStream('stderr');
      const after = drive();
      // Nothing at all on fd 1: the whole point is that a caller can `JSON.parse` what is there.
      expect(after.out).toEqual([]);
      expect(after.err.join('')).toContain('ultimate migrate applied');
      expect(after.err.join('')).toContain('ultimate migrate failed');
    } finally {
      setLogStream('stdout');
    }
    // An error was always on stderr, and moving the stream back does not change that.
    expect(drive().out.join('')).not.toContain('ultimate migrate failed');
  });
});

/**
 * The defect a server-side test cannot see, because the runtime it runs in has the binding.
 *
 * `logger` at the foot of `logger.ts` is `structuredLogger()` at MODULE INIT, and `envLevel()` read a
 * bare `process.env['LOG_LEVEL']`. `@ultimat3/core`'s barrel is what every other package imports,
 * `@ultimat3/realtime`'s `channel.ts` calls `logger.warn`, and so the shaker keeps `logger` in the
 * chunk of any island that reaches a live subscription. Measured on ai-maxxing's session console
 * island: the chunk threw `ReferenceError: process is not defined` at evaluation, the wrapper
 * rendered `data-x-failed="process is not defined"`, and the island never mounted.
 *
 * WHY A SUBPROCESS, and why `Reflect.deleteProperty`. `scripts/browser-barrel.test.ts` evaluates
 * its chunks with `bun run` — where `process` is a global, so the bad read succeeds and the whole
 * class of defect is invisible to it. Deleting the binding is what makes the evaluation a browser's
 * rather than Bun's; deleting it in THIS process would take the test runner with it, and `--isolate`
 * does not isolate one test from another inside a file. `bun run` also makes "throws at module
 * scope" mean exactly that.
 *
 * WHAT IT DOES NOT CLAIM: that a browser can run everything in the barrel. `defaultWriter` reaching
 * `console` and `envLevel` taking its default are the two things a browser needs of the LOGGER, and
 * they are what is asserted.
 */
describe('the process-wide logger, in a runtime with no process', () => {
  // why: Bun ships no temp-directory API of its own, and a chunk built for this suite must never
  // be written into the source tree — `mkdtemp` is the only one that answers.
  const dir = trackedDir(join(tmpdir(), 'ultimate-logger-browser-'));

  /**
   * Reports through `console.log`, which is a browser's and Bun's alike, because the one thing it
   * cannot use to answer is the binding it just deleted. It also swaps `console.log` around the
   * emit so the logger's own default writer is captured rather than printed — that swap IS the
   * assertion that a line reaches `console` when there is no fd to reach.
   */
  const RUNNER = [
    'const target = globalThis.process.argv[2];',
    'const say = console.log.bind(console);',
    'Reflect.deleteProperty(globalThis, "process");',
    'const mod = await import(target);',
    'const seen = [];',
    'console.log = (line) => { seen.push(String(line)); };',
    'try { mod.emit("a line with no process"); } finally { console.log = say; }',
    'say(JSON.stringify({ level: mod.level, seen }));',
    '',
  ].join('\n');

  /** A fixture entry that reaches the barrel and exports what `RUNNER` calls — the entry carries
   * the probe, so it is a module of its own rather than `index.ts`. */
  async function chunkOf(name: string, source: string): Promise<string> {
    const root = await dir;
    const entry = join(root, `${name}.entry.ts`);
    await Bun.write(entry, source);
    const output = await Bun.build({ entrypoints: [entry], target: 'browser' });
    expect(output.success).toBe(true);
    const built = output.outputs[0] ?? expect.unreachable('the browser build emitted no chunk');
    const file = join(root, `${name}.mjs`);
    await Bun.write(file, await built.text());
    return file;
  }

  /** The chunk evaluated with the binding gone: its stdout, or the failure that replaced it. */
  async function evaluate(file: string): Promise<{ readonly ok: boolean; readonly text: string }> {
    const root = await dir;
    const runner = join(root, 'runner.mjs');
    await Bun.write(runner, RUNNER);
    // Awaited, never `Bun.spawnSync`: a synchronous wait holds the test worker's only thread, so
    // a child that does not come back is a worker the test timeout cannot end. Awaited, it is one
    // red test.
    const run = Bun.spawn(['bun', 'run', runner, file], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    return { ok: code === 0, text: `${stdout}${stderr}` };
  }

  const BARREL = JSON.stringify(join(import.meta.dir, 'index.ts'));

  // The negative control, first: without it every assertion below could pass on a harness that
  // silently kept the binding, which is exactly what evaluating under plain `bun run` does.
  test('the harness can fail — a module-scope process read still throws here', async () => {
    const file = await chunkOf(
      'control',
      [
        `export { logger } from ${BARREL};`,
        "export const level = process.env['LOG_LEVEL'] ?? 'info';",
        'export const emit = () => {};',
        '',
      ].join('\n'),
    );
    const run = await evaluate(file);
    expect(run.ok).toBe(false);
    expect(run.text).toContain('process is not defined');
  }, 60_000);

  test('evaluates, takes the default level, and writes its lines to console', async () => {
    const file = await chunkOf(
      'logger',
      [
        `import { logger } from ${BARREL};`,
        'export const level = logger.level;',
        'export const emit = (message) => { logger.info(message); };',
        '',
      ].join('\n'),
    );
    const run = await evaluate(file);
    // The message the app saw, named so a regression reads as itself rather than as a parse error.
    expect(run.text).not.toContain('process is not defined');
    expect(run.ok).toBe(true);
    const answer = JSON.parse(run.text.trim().split('\n').at(-1) ?? '{}') as {
      level?: unknown;
      seen?: unknown;
    };
    expect(answer.level).toBe('info');
    expect(answer.seen).toEqual([
      expect.stringContaining('"msg":"a line with no process"') as unknown as string,
    ]);
  }, 60_000);
});
