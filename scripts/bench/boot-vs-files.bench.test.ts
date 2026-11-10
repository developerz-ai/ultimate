// The boot bench end to end on a tiny fixture: real cold boots in child processes, both modes, the
// figure parsed back — and the flags it refuses before any process starts. The child's own import
// loop is driven in process over plain modules, so no entity registers into this test's registry.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp directory or recursive delete of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: as above — the platform temp root is only node:os's to name.
import { tmpdir } from 'node:os';
import { ScriptError } from '../lib/script-error';
import { bootArgs, runBootBench } from './boot-vs-files.bench';
import { bootChildArgs, bootModules } from './boot-vs-files-child';

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof ScriptError ? error.code : 'not a ScriptError';
  }
  return undefined;
};

describe('boot-vs-files bench', () => {
  test('two cold boots per mode, a figure each, written where --out says', async () => {
    const dir = await mkdtemp(`${tmpdir()}/boot-bench-`);
    scratch.push(dir);
    const lines: string[] = [];
    const results = await runBootBench(
      ['--files', '3', '--runs', '1', '--out', `${dir}/out.json`],
      (line) => lines.push(line),
    );
    expect(results.map((run) => run.files)).toEqual([3]);
    expect(results[0]?.serialMs).toBeGreaterThanOrEqual(0);
    expect(results[0]?.batchedMs).toBeGreaterThanOrEqual(0);
    expect(lines).toEqual([expect.stringMatching(/^3 files: serial \d+ ms, batched \d+ ms$/)]);
    const written = (await Bun.file(`${dir}/out.json`).json()) as { results: unknown[] };
    expect(written.results).toHaveLength(1);
  }, 60_000);

  test('--json prints the whole result instead of the lines', async () => {
    const lines: string[] = [];
    await runBootBench(['--files', '2', '--runs', '1', '--json'], (line) => lines.push(line));
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ runs: 1, results: [{ files: 2 }] });
  }, 60_000);

  test('a file count or run count out of range is refused before anything runs', () => {
    expect(codeOf(() => bootArgs(['--files', '0']))).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(() => bootArgs(['--files', '2.5']))).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(() => bootArgs(['--runs', '99']))).toBe('X_CLI_BAD_FLAG');
    expect(bootArgs([]).counts).toEqual([500, 2_000, 5_000]);
  });
});

describe('boot-vs-files child', () => {
  test('imports every module in both modes and counts them', async () => {
    const dir = await mkdtemp(`${tmpdir()}/boot-child-`);
    scratch.push(dir);
    await Bun.write(`${dir}/a.ts`, 'export const a = 1;\n');
    await Bun.write(`${dir}/b.ts`, "import { a } from './a';\nexport const b = a + 1;\n");
    expect((await bootModules(dir, 'serial')).modules).toBe(2);
    expect((await bootModules(dir, 'batched')).modules).toBe(2);
  });

  test('a module that will not import fails the batched boot, never times it', async () => {
    const dir = await mkdtemp(`${tmpdir()}/boot-broken-`);
    scratch.push(dir);
    await Bun.write(`${dir}/a.ts`, "throw new TypeError('broken on purpose');\n");
    const refused = await bootModules(dir, 'batched').then(
      () => 'resolved',
      (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
    );
    expect(refused).toBe('X_BENCH_RUN_FAILED');
  });

  test('--dir and --mode are required', () => {
    expect(codeOf(() => bootChildArgs(['--dir', '/x']))).toBe('X_CLI_BAD_FLAG');
    expect(bootChildArgs(['--dir', '/x', '--mode', 'serial'])).toEqual({
      dir: '/x',
      mode: 'serial',
    });
  });
});
