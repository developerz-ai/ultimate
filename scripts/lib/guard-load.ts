// A guard whose own import graph failed to LOAD is not a guard that found something, and it must
// not read as a stack trace: with six agents editing packages at once, `Export named '…' not found`
// out of a half-written module crashed `gate-codes`, `doc-commands`, `gate-steps`, `lockfile` and
// `declaration-readers` for most of a round, each printing a bare SyntaxError with no code and no
// next step. This turns exactly that failure into `X_GUARD_LOAD_FAILED`, naming the module.
//
// Two ways in, one answer: `guard-preload.ts` as a `--preload` (a STATIC import fails at link time,
// before a line of the script runs, so only a preload can catch it), and `loadOrReport()` for a
// guard's own dynamic `import()`. Imports no workspace package: it has to run while they are
// broken.

import type { Finding } from './log';
import { report } from './log';
import { insideRoot, toPosix } from './posix-path';
import { repoRoot } from './run';

export interface LoadFailure {
  /** The module the runtime could not link or resolve, as it named it. */
  readonly module: string;
  readonly message: string;
}

/**
 * `Export named 'x' not found in module '<path>'` and `Cannot find module '<spec>' from '<path>'`
 * (`… imported from <path>` for a dynamic `import()`) are Bun's two load-time refusals. Anything else — a guard's own TypeError, a failing assertion —
 * is not a load failure and is left exactly as it was thrown.
 */
export function loadFailureOf(error: unknown): LoadFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const raw: unknown = (error as { readonly message?: unknown }).message;
  const message = typeof raw === 'string' ? raw : '';
  const exported = /Export named '[^']+' not found in module '([^']+)'/.exec(message);
  if (exported?.[1] !== undefined) return { module: exported[1], message };
  // A static import says `from '<path>'`; a dynamic `import()` says `imported from <path>`.
  const missing = /Cannot find module '[^']+' (?:from '([^']+)'|imported from (\S+))/.exec(message);
  const importer = missing?.[1] ?? missing?.[2];
  if (importer !== undefined) return { module: importer, message };
  return undefined;
}

/**
 * Repo-relative when it can be and `/`-spelt always, so the finding reads the same on every
 * machine — a Windows `D:\repo\scripts\x.ts` included, which a `${root}/` prefix never matched.
 */
const shown = (module: string, root: string): string => insideRoot(root, module) ?? toPosix(module);

/** What `bun run <script>` may carry: a `package.json` script name — never opening with `-`. */
const SCRIPT_NAME = /^\w[\w-]*$/;

/** The runtime's message with the checkout's prefix cut, in whichever separator it spelt it. */
const withoutRoot = (message: string, root: string): string =>
  message.replace(`${root}/`, '').replace(`${root}\\`, '');

export function loadFinding(script: string, failure: LoadFailure, root: string): Finding {
  const module = shown(failure.module, root);
  // The name is pasted into a shell. `scriptName` already cuts argv to `[\w-]+`, but its fallback
  // is `the guard` and a caller of `loadOrReport` passes its own — so the command is emitted only
  // for a real script name, and prose otherwise. This file imports no workspace package, so core's
  // `renderFixShellArg` is out of reach.
  const rerun = SCRIPT_NAME.test(script) ? `bun run ${script}` : 'rerun the guard you ran';
  return {
    code: 'X_GUARD_LOAD_FAILED',
    at: module,
    cause: `${script} could not load its imports — ${withoutRoot(failure.message, root)} — so it checked nothing; a package in its import graph is mid-edit or broken`,
    fix: `edit ${module} until bun run typecheck is clean, then rerun: ${rerun}`,
  };
}

/**
 * The script a `bun --preload … scripts/<name>.ts` run is for, as `package.json` names it. Either
 * separator: on Windows the entry is `…\scripts\<name>.ts`, and a `/`-only match fell back to
 * `the guard` — a finding no reader could rerun.
 */
export const scriptName = (argv: readonly string[]): string => {
  const entry = argv.find((arg) => /scripts[\\/][\w-]+\.ts$/.test(arg)) ?? 'the guard';
  return entry.replace(/^.*scripts[\\/]/, '').replace(/\.ts$/, '');
};

function reportLoadFailure(script: string, failure: LoadFailure): never {
  const json = process.argv.includes('--json');
  const finding = loadFinding(script, failure, repoRoot());
  return report({ ok: false, script, summary: `${script} did not run`, findings: [finding] }, json);
}

/** A guard's own `import()`, with a load failure reported rather than thrown. */
export async function loadOrReport<T>(script: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const failure = loadFailureOf(error);
    if (failure === undefined) throw error;
    return reportLoadFailure(script, failure);
  }
}

/** What `guard-preload.ts` runs. Separate so importing this module installs nothing. */
export function installLoadGuard(argv: readonly string[] = process.argv): void {
  const script = scriptName(argv);
  process.on('uncaughtException', (error) => {
    const failure = loadFailureOf(error);
    if (failure !== undefined) reportLoadFailure(script, failure);
    // Not ours: the runtime's own rendering, and its exit code.
    console.error(error);
    process.exit(1);
  });
}
