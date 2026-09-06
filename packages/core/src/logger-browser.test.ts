// The logger's browser seam, and nothing else: a chunk built for `target: 'browser'` and evaluated
// with `globalThis.process` deleted. It is a separate file because it is a separate harness — it
// builds and spawns, where `logger.test.ts` only calls — and because that harness is the one thing
// in this package that a plain in-process test can never stand in for.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, and the browser chunk this suite builds must be written
// somewhere that is not the source tree; `rm` is the recursive remove Bun also lacks.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform's temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive, and `Bun.write` takes a path already joined.
import { join } from 'node:path';

/**
 * The defect a server-side test cannot see, because the runtime it runs in has the binding.
 *
 * `logger` at the foot of `logger.ts` is `createLogger()` at MODULE INIT, and `envLevel()` read a
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
  const dir = mkdtemp(join(tmpdir(), 'ultimate-logger-browser-'));

  // The entry, the chunk and the runner are this suite's only artefacts, and the platform's temp
  // root is not a wastebasket someone else empties. `force` so a run that failed before the
  // directory existed does not fail again on the way out.
  afterAll(async () => {
    await rm(await dir, { recursive: true, force: true });
  });

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

  /** Bundled through a re-exporting wrapper, the way an app consumes the barrel — never with
   * `index.ts` as the entry, which Bun 1.4.0 shakes down to its export clause (#276). */
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
    const run = Bun.spawnSync(['bun', 'run', runner, file]);
    return {
      ok: run.exitCode === 0,
      text: `${run.stdout.toString()}${run.stderr.toString()}`,
    };
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
