// One cold boot for `boot-vs-files.bench.ts`: a fresh process imports every module of a synthetic
// app directory, either one `await import()` after another (how `x` booted before plan 101 B1) or
// through the CLI's batched loader (`importInOrder`), and prints `FINAL <json>` with the wall time.
//
//   bun run scripts/bench/boot-vs-files-child.ts --dir <fixture dir> --mode serial|batched

import { importInOrder } from '../../packages/cli/src/app-load-batch';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';

export type BootMode = 'serial' | 'batched';

/** `--dir` and `--mode`, or the refusal naming both. */
export function bootChildArgs(argv: readonly string[]): { dir: string; mode: BootMode } {
  const args = parseScriptArgs(argv);
  const dir = args.flags.get('dir');
  const mode = args.flags.get('mode');
  if (typeof dir !== 'string' || (mode !== 'serial' && mode !== 'batched')) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause: 'boot-vs-files-child is spawned by the bench with --dir and --mode serial|batched',
      fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500',
    });
  }
  return { dir, mode };
}

/** Import every `*.ts` under `dir` in sorted order, the way `mode` boots, and time it. */
export async function bootModules(
  dir: string,
  mode: BootMode,
): Promise<{ modules: number; ms: number }> {
  const files = [...new Bun.Glob('*.ts').scanSync({ cwd: dir, absolute: true })].sort();
  const started = performance.now();
  if (mode === 'serial') {
    for (const file of files) await import(file);
  } else {
    const imported = await importInOrder(files);
    if (imported.some((entry) => !entry.ok)) {
      throw new ScriptError({
        code: 'X_BENCH_RUN_FAILED',
        cause: 'a synthetic app module failed to import, so the boot time measures a broken app',
        fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500 --json',
      });
    }
  }
  return { modules: files.length, ms: Math.round(performance.now() - started) };
}

if (import.meta.main) {
  const { dir, mode } = bootChildArgs(Bun.argv.slice(2));
  console.log(`FINAL ${JSON.stringify(await bootModules(dir, mode))}`);
}
