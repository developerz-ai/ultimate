// One cause, one step. A module that will not import was reported by up to four steps at once —
// `contract-diff`, `budgets`, `policy` and `manifest` all load the app, and each carried the load's
// findings — so one syntax error read as four red steps and four copies of one line (plan 101
// slice 11 i). The `manifest` step owns them: it runs in every repo, and "does the projection
// describe the code?" is the question a module that will not import answers first.

import { loadApp } from './app-load';
import type { Finding } from './output';
import type { StepOutcome, VerifyStepName } from './verify-step';

/** The step that reports the app's load failures. Every other step points at it. */
export const LOAD_OWNER: VerifyStepName = 'manifest';

/** What the app load reports, as the step sees it. */
export type LoadProbe = (root: string) => Promise<{ readonly findings: readonly Finding[] }>;

const keyOf = (finding: Finding): string =>
  [finding.code, finding.at ?? '', finding.cause].join('\u0000');

/**
 * `findings` without the ones the app load raised, and an `output` line saying where they went.
 * The step's own verdict stands on what is left: a budget the broken module left unmeasured is
 * still this step's finding, only its cause moved.
 */
export async function withoutLoadFindings(
  root: string,
  findings: readonly Finding[],
  load: LoadProbe = loadApp,
): Promise<StepOutcome> {
  const loaded = new Set((await load(root)).findings.map(keyOf));
  const kept = findings.filter((finding) => !loaded.has(keyOf(finding)));
  const moved = findings.length - kept.length;
  return {
    ok: kept.length === 0,
    findings: kept,
    ...(moved === 0
      ? {}
      : { output: `skipped: ${moved} module-load finding(s) — see ${LOAD_OWNER}` }),
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
