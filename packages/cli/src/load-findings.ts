// One cause, one finding. A module that will not import leaves every registry half-filled, and each
// step that loaded the app reported what half a registry looks like — a permission typo read as 9
// findings across 7 steps (plan 101 19a FX8). The `manifest` step owns the load's findings: it runs
// in every repo, and "does the projection describe the code?" is the question a broken module
// answers first. Every other step that loads the app stands down while the load is red.

import { loadApp } from './app-load';
import { msg } from './messages';
import type { Finding } from './output';
import type { VerifyContext, VerifyStep, VerifyStepName } from './verify-step';

/** The step that reports the app's load failures. Every other step points at it. */
export const LOAD_OWNER: VerifyStepName = 'manifest';

/** What a dependent step says instead of running over a half-loaded registry. */
export const LOAD_BLOCKED = msg('cli.verify.loadBlocked', { owner: LOAD_OWNER });

/** What the app load reports, as the step sees it. */
export type LoadProbe = (root: string) => Promise<{ readonly findings: readonly Finding[] }>;

const keyOf = (finding: Finding): string =>
  [finding.code, finding.at ?? '', finding.cause].join('\u0000');

/** Whether this run reports the owner step: the gate always does, `--only` when it names it. */
function ownerRuns(ctx: VerifyContext): boolean {
  if (ctx.only === undefined) return true;
  return typeof ctx.only === 'string' ? ctx.only === LOAD_OWNER : ctx.only.includes(LOAD_OWNER);
}

/**
 * `step`, standing down while the app's load has findings. A run that includes the owner gets one
 * line saying where the cause went and no findings — the gate is red on `manifest` already. A
 * narrowed run without the owner (`x verify --only budgets`) carries the load's findings itself:
 * skipping there would be a green over an app that does not load.
 */
export function blockedByLoad(step: VerifyStep, load: LoadProbe = loadApp): VerifyStep {
  return {
    ...step,
    async run(ctx) {
      const { findings } = await load(ctx.root);
      if (findings.length === 0) return step.run(ctx);
      return ownerRuns(ctx)
        ? { ok: true, findings: [], output: LOAD_BLOCKED }
        : { ok: false, findings, output: LOAD_BLOCKED };
    },
  };
}

/** The owner's half: every load finding exactly once, beside what the step found itself. */
export async function withLoadFindings(
  root: string,
  findings: readonly Finding[],
  load: LoadProbe = loadApp,
): Promise<readonly Finding[]> {
  const own = (await load(root)).findings;
  const seen = new Set(own.map(keyOf));
  return [...own, ...findings.filter((finding) => !seen.has(keyOf(finding)))];
}
