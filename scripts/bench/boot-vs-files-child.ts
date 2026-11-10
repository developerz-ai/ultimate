// One cold boot for `boot-vs-files.bench.ts`: a fresh process imports every module of a synthetic
// app directory, either one `await import()` after another (how `x` booted before plan 101 B1) or
// through the CLI's batched loader (`importInOrder`), and prints `FINAL <json>` with the wall time.
//
//   bun run scripts/bench/boot-vs-files-child.ts --dir <fixture dir> --mode serial|batched

import { importInOrder } from '../../packages/cli/src/app-load-batch';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';

const args = parseScriptArgs(Bun.argv.slice(2));
const dir = args.flags.get('dir');
const mode = args.flags.get('mode');
if (typeof dir !== 'string' || (mode !== 'serial' && mode !== 'batched')) {
  throw new ScriptError({
    code: 'X_CLI_BAD_FLAG',
    cause: 'boot-vs-files-child is spawned by the bench with --dir and --mode serial|batched',
    fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500',
  });
}

const files = [...new Bun.Glob('*.ts').scanSync({ cwd: dir, absolute: true })].sort();
const started = performance.now();
if (mode === 'serial') {
  for (const file of files) await import(file);
} else {
  const imported = await importInOrder(files);
  const failed = imported.find((entry) => !entry.ok);
  if (failed !== undefined && !failed.ok) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: 'a synthetic app module failed to import, so the boot time measures a broken app',
      fix: 'bun run scripts/bench/boot-vs-files.bench.ts --files 500 --json',
    });
  }
}
const ms = performance.now() - started;
console.log(`FINAL ${JSON.stringify({ modules: files.length, ms: Math.round(ms) })}`);
