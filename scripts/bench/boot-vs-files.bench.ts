#!/usr/bin/env bun
// App-module load time against file count (plan 101 slice 22, B1): a synthetic app of N modules,
// each an `entity()` file, imported cold in a fresh process — serially, as `x` booted before B1,
// and through the CLI's batched loader (`importInOrder`). The median of `--runs` cold boots each.
// Module load only: no server, no database — the part of a boot that grew with the app.
//
//   bun run scripts/bench/boot-vs-files.bench.ts [--files 500,2000,5000] [--runs 3]
//     [--out <file.json>] [--json]
//
// The fixture is written under `packages/cli/node_modules/.cache/bench-boot/` — the root has no
// `@ultimat3/*` links, the CLI's install does — so imports resolve to the workspace and nothing
// lands in the tree.

// why: Bun ships no directory create or recursive delete of its own.
import { mkdir, rm } from 'node:fs/promises';
import { parseScriptArgs } from '../lib/args';
import { repoRoot } from '../lib/run';
import { ScriptError } from '../lib/script-error';
import { DEFAULT_FILE_COUNTS, median, moduleName, moduleSource } from './boot-vs-files-shape';
import { boxFacts, readCount } from './http-hello';

const CHILD = Bun.fileURLToPath(new URL('./boot-vs-files-child.ts', import.meta.url));

export interface BootRun {
  readonly files: number;
  readonly serialMs: number;
  readonly batchedMs: number;
  /** Per thousand files, serial — the slope the plan measured at ~5 ms a file. */
  readonly serialMsPer1k: number;
  readonly batchedMsPer1k: number;
}

const fixtureRoot = (): string => `${repoRoot()}/packages/cli/node_modules/.cache/bench-boot`;

/** N synthetic modules under the CLI's install, written fresh; answers the directory. */
export async function writeFixture(files: number): Promise<string> {
  const dir = `${fixtureRoot()}/${String(files)}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: files }, (_, index) =>
      Bun.write(`${dir}/${moduleName(index)}`, moduleSource(index)),
    ),
  );
  return dir;
}

async function coldBoot(dir: string, mode: 'serial' | 'batched'): Promise<number> {
  const child = Bun.spawn(['bun', CHILD, '--dir', dir, '--mode', mode], {
    stdout: 'pipe',
    stderr: 'pipe',
    // A 5,000-module import is seconds; minutes is a hung loader.
    timeout: 300_000,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = out.split('\n').find((entry) => entry.startsWith('FINAL '));
  if (code !== 0 || line === undefined) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `a ${mode} cold boot exited ${String(code)} without a figure: ${err.slice(0, 400)}`,
      fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500 --runs 1',
    });
  }
  const parsed: unknown = JSON.parse(line.slice('FINAL '.length));
  const ms = (parsed as { ms?: unknown }).ms;
  return typeof ms === 'number' ? ms : Number.NaN;
}

export async function benchBoot(counts: readonly number[], runs: number): Promise<BootRun[]> {
  const out: BootRun[] = [];
  for (const files of counts) {
    const dir = await writeFixture(files);
    // One warm-up of each, discarded: the first import of a fresh file pays Bun's transpile cache.
    await coldBoot(dir, 'serial');
    await coldBoot(dir, 'batched');
    const serial: number[] = [];
    const batched: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      serial.push(await coldBoot(dir, 'serial'));
      batched.push(await coldBoot(dir, 'batched'));
    }
    const serialMs = median(serial);
    const batchedMs = median(batched);
    out.push({
      files,
      serialMs,
      batchedMs,
      serialMsPer1k: Math.round((serialMs * 1_000) / files),
      batchedMsPer1k: Math.round((batchedMs * 1_000) / files),
    });
    await rm(dir, { recursive: true, force: true });
  }
  await rm(fixtureRoot(), { recursive: true, force: true });
  return out;
}

/** `--files` and `--runs`, or the refusal naming both. */
export function bootArgs(argv: readonly string[]) {
  const args = parseScriptArgs(argv);
  const rawFiles = args.flags.get('files');
  const counts =
    typeof rawFiles === 'string'
      ? rawFiles.split(',').map((part) => Number(part))
      : DEFAULT_FILE_COUNTS;
  const runs = readCount(args.flags.get('runs'), 3, { flag: 'runs', min: 1, max: 15 });
  if (
    typeof runs !== 'number' ||
    !counts.every((n) => Number.isInteger(n) && n >= 1 && n <= 50_000)
  ) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause:
        'boot-vs-files takes --files as whole numbers 1..50000, comma separated, and --runs 1..15',
      fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500,2000,5000 --runs 3',
    });
  }
  const out = args.flags.get('out');
  return { counts, runs, out: typeof out === 'string' ? out : undefined, json: args.json };
}

/** The whole command: measure, write `--out`, print. `log` is the test's seam onto stdout. */
export async function runBootBench(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<readonly BootRun[]> {
  const { counts, runs, out, json } = bootArgs(argv);
  const results = await benchBoot(counts, runs);
  const data = { box: boxFacts(Bun.env), runs, results };
  if (out !== undefined) await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  if (json) log(JSON.stringify(data, null, 2));
  else {
    for (const r of results)
      log(`${r.files} files: serial ${r.serialMs} ms, batched ${r.batchedMs} ms`);
  }
  return results;
}

if (import.meta.main) await runBootBench(Bun.argv.slice(2));
