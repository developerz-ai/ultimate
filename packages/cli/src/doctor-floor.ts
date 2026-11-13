// `x doctor`'s floor check: a gate step that applies to this app — its suite files exist, its
// input is committed — and that `x.verify.json`'s `steps` does not hold. Unfloored, deleting the
// suite turns the step from green into skipped-and-green; floored, it is `X_VERIFY_SUITE_VANISHED`.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Runner } from './exec';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';
import { VERIFY_STEPS } from './verify-checks';
import { floorRequires, readVerifyFloor, VERIFY_FLOOR_FILE } from './verify-floor';
import type { VerifyStep, VerifyStepName } from './verify-step';

export const STEP_UNFLOORED = 'X_VERIFY_STEP_UNFLOORED';

/**
 * Never proposed. `x new` writes `e2e` as an `e2eTest` that skips until the app registers a
 * browser driver, so its file exists while the step runs nothing: flooring it reds a fresh app's
 * gate on the scaffold's own placeholder (`scaffold-verify-floor.ts`). The gate's summary already
 * names it as skipped; the floor is the app's call once a driver makes it run.
 */
const NEVER_PROPOSED: ReadonlySet<VerifyStepName> = new Set<VerifyStepName>(['e2e']);

/** `applies` reads the disk alone: a step that spawned here would be asking the wrong question. */
const noRunner: Runner = async (command) => ({
  command,
  code: 1,
  ok: false,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

/** The I/O half: each step with an `applies`, asked of this root, that the floor does not hold. */
export async function unflooredStepsProbe(
  root: string,
  steps: readonly VerifyStep[] = VERIFY_STEPS,
): Promise<readonly VerifyStepName[]> {
  const floor = await readVerifyFloor(root);
  const unfloored: VerifyStepName[] = [];
  for (const step of steps) {
    if (step.applies === undefined || NEVER_PROPOSED.has(step.name)) continue;
    if (floorRequires(floor, step.name)) continue;
    const applies = await step.applies({ root, runner: noRunner }).catch(() => false);
    if (applies) unfloored.push(step.name);
  }
  return unfloored;
}

/** The rule, pure: one finding naming every unfloored step, run-first, so the edit is proven. */
export function unflooredStepFindings(steps: readonly VerifyStepName[]): readonly Finding[] {
  if (steps.length === 0) return [];
  return [
    {
      code: STEP_UNFLOORED,
      cause: `${steps.join(', ')} ${steps.length === 1 ? 'applies' : 'apply'} to this app and ${VERIFY_FLOOR_FILE} "steps" does not hold ${steps.length === 1 ? 'it' : 'them'}, so a deleted suite reads as skipped and the gate stays green`,
      // Run first: a step that skips here would red the gate the moment the floor names it.
      fix: `x verify --only ${quoteArg(steps.join(','))} --json   # then add each step that passed, not skipped, to "steps" in ${VERIFY_FLOOR_FILE}`,
      docs: ERROR_DOCS_URL,
      at: VERIFY_FLOOR_FILE,
    },
  ];
}
