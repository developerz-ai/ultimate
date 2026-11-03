// The budgets step's first half: when the stats on disk cannot be read as this tree's, run the one
// builder (`x build --target static`) through the step's runner, so the build is a tagged child
// under the step's deadline. Its output goes to `.x/verify-static`, never over a deployable
// `.x/static`; the stats it weighs always land in `.x/build-stats.json` (`prerender.ts`).

// why: Bun exposes no path-join primitive; every path here is assembled from the app root.
import { join } from 'node:path';
import { ERROR_DOCS_URL, isCompiledBundle } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { BUILD_STATS_FILE, readBuildStats } from './budgets';
import type { BudgetsFreshness } from './budgets-freshness';
import { budgetsFreshness } from './budgets-freshness';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { Finding } from './output';
import { newestSourceMtime } from './source-mtime';
import { documentIn } from './upgrade-gate';

/** Where the gate's own build writes its pages: inside `.x/`, gitignored, apart from `.x/static`. */
export const VERIFY_STATIC_OUT = join('.x', 'verify-static');

/** `x build`'s argv, spawned as this process's own CLI: the source entry, or a compiled binary. */
export function verifyBuildCommand(): readonly string[] {
  const words = ['build', '--target', 'static', '--no-preflight', '--out', VERIFY_STATIC_OUT];
  const self = isCompiledBundle(import.meta.dir) ? [] : [join(import.meta.dir, 'bin.ts')];
  return [process.execPath, ...self, ...words, '--json'];
}

const statsMtime = async (path: string): Promise<number | undefined> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.lastModified : undefined;
};

/** The stats file's state against this tree. */
export async function statsFreshness(root: string): Promise<BudgetsFreshness> {
  const stats = await readBuildStats(root);
  const path = join(root, BUILD_STATS_FILE);
  return budgetsFreshness({
    stats,
    statsMtimeMs: stats === undefined ? undefined : await statsMtime(path),
    newestSourceMtimeMs: await newestSourceMtime(root),
  });
}

const FINDING = t.object({
  code: t.string,
  cause: t.string,
  fix: t.string,
  docs: t.optional(t.string),
  at: t.optional(t.string),
});
const BUILD_DOCUMENT = t.object({
  findings: t.optional(t.array(FINDING)),
  data: t.optional(t.object({ output: t.optional(t.string) })),
});

interface BuildDocument {
  readonly findings?: readonly Finding[];
  readonly data?: { readonly output?: string };
}

export interface MeasuredFirst {
  readonly state: BudgetsFreshness;
  /** Whether this step spawned the build. */
  readonly built: boolean;
  /** The build's own findings when it failed: the step's, unchanged. Empty when it passed. */
  readonly findings: readonly Finding[];
  /** One line saying the step built and why, then a failed build's output. Absent when fresh. */
  readonly output?: string;
}

/**
 * Build first unless the stats are fresh. A failed build's findings are returned as the build
 * reported them, its code and its `fix:`; a build that printed no document is `X_BUILD_FAILED` with
 * what it printed, and the command that shows it again.
 */
export async function measureIfStale(ctx: {
  readonly root: string;
  readonly runner: Runner;
}): Promise<MeasuredFirst> {
  const state = await statsFreshness(ctx.root);
  if (state === 'fresh') return { state, built: false, findings: [] };
  const command = verifyBuildCommand();
  const result = await ctx.runner(command, { cwd: ctx.root });
  const ran = msg('cli.verify.budgets.built', {
    state,
    out: VERIFY_STATIC_OUT,
    ms: result.durationMs,
  });
  if (result.ok) return { state, built: true, findings: [], output: ran };
  const parsed = BUILD_DOCUMENT.safeParse(documentIn(result.stdout));
  const document = parsed.issues === undefined ? (parsed.value as BuildDocument) : undefined;
  const reported = document?.findings ?? [];
  const output = document?.data?.output ?? execOutput(result);
  const findings: readonly Finding[] =
    reported.length > 0
      ? reported
      : [
          {
            code: 'X_BUILD_FAILED',
            cause: `${command.slice(-8).join(' ')} exited ${String(result.code)} with no JSON report, so x verify could not weigh this tree`,
            fix: 'x build --target static --json',
            docs: ERROR_DOCS_URL,
          },
        ];
  return { state, built: true, findings, output: [ran, output].join('\n') };
}
