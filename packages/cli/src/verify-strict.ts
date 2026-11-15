// `strict` and `skip` in `x.verify.json`: a gate where every step either ran a check or carries a
// written reason it cannot here. `steps` is a floor an app grows by hand, so a step it never listed
// skips in silence forever; strict turns every unlisted skip red unless `skip` says why.

import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import type { Finding } from './output';
import { GATE_COMMAND } from './verify-step';

/** The floor's strict switch. Named once: the problem quotes it and the fix repairs it. */
export const STRICT_FIELD = 'strict';

/** The floor's written reasons: step name → why it runs no check in this repository. */
export const SKIP_FIELD = 'skip';

/**
 * Strict red's code. A string here until the coordinator registers it in `error-codes.ts`; the
 * literal is the one spelling every reader of this module uses.
 */
export const STRICT_UNRUN_CODE = 'X_VERIFY_STRICT_UNRUN';

/** Step name → the written reason it runs no check here. */
export type SkipReasons = Readonly<Record<string, string>>;

/** The two keys as `parseVerifyFloor` folds them in: off and none when absent. */
export interface StrictFloor {
  readonly strict?: boolean;
  readonly skip?: SkipReasons;
}

/**
 * `strict` (true or false) and `skip` (`{ "<step>": "<why>" }`, a step the gate runs, a non-empty
 * reason, never one `steps` already requires), or the problems. A why that is blank is no why: it
 * is the silent skip strict exists to refuse, typed into the file.
 */
export function readStrict(
  payload: Record<string, unknown> | undefined,
  declared: readonly string[],
): StrictFloor & { readonly problems: readonly string[] } {
  const problems: string[] = [];
  const rawStrict = payload?.[STRICT_FIELD];
  let strict: boolean | undefined;
  if (rawStrict !== undefined) {
    if (typeof rawStrict === 'boolean') strict = rawStrict;
    else
      problems.push(
        `"${STRICT_FIELD}" is ${JSON.stringify(rawStrict)}, which is not true or false`,
      );
  }
  const rawSkip = payload?.[SKIP_FIELD];
  const skip = new Map<string, string>();
  if (rawSkip !== undefined) {
    if (typeof rawSkip !== 'object' || rawSkip === null || Array.isArray(rawSkip)) {
      problems.push(`"${SKIP_FIELD}" is not an object of { "<step>": "<why>" }`);
    } else {
      const required = Array.isArray(payload?.['steps']) ? (payload['steps'] as unknown[]) : [];
      for (const [step, why] of Object.entries(rawSkip)) {
        if (!declared.includes(step)) {
          problems.push(`"${SKIP_FIELD}" names ${step}, which x verify does not run`);
        } else if (typeof why !== 'string' || why.trim() === '') {
          problems.push(`"${SKIP_FIELD}" gives ${step} no written why`);
        } else if (required.includes(step)) {
          problems.push(`"${SKIP_FIELD}" excuses ${step}, which the floor's step list requires`);
        } else skip.set(step, why.trim());
      }
    }
  }
  return {
    ...(strict === undefined ? {} : { strict }),
    ...(skip.size === 0 ? {} : { skip: Object.fromEntries(skip) }),
    problems,
  };
}

/** The written why for this step, when the floor carries one. */
export const skipWhy = (floor: StrictFloor | undefined, step: string): string | undefined =>
  floor?.skip !== undefined && Object.hasOwn(floor.skip, step) ? floor.skip[step] : undefined;

/**
 * A step that ran no check, under a strict floor, with no why. The fix opens with the command that
 * shows what the step needs, and carries the edit that excuses it behind the `#`: either is right,
 * and neither is the gate's to perform on its own file.
 */
export const strictUnrunFinding = (
  step: string,
  reason: string,
  command: string = GATE_COMMAND,
): Finding => ({
  code: STRICT_UNRUN_CODE,
  cause: `x.verify.json is strict and the ${step} step ran no check (${reason}) with no written why`,
  fix: `${command} --only ${renderFixShellArg(step, '<step>')} --json   # give ${step} a suite or an input to run, or write "${SKIP_FIELD}": { "${step}": "<why>" } in x.verify.json`,
  docs: ERROR_DOCS_URL,
  at: 'x.verify.json',
});

/**
 * The verdict on one step that ran no check. Strict and unexcused is red; a step the floor's
 * `steps` requires is the vanished-suite finding's to report, so it is never judged twice here.
 */
export const judgeUnrun = (
  floor: StrictFloor | undefined,
  step: string,
  reason: string,
  required: boolean,
  command?: string,
): readonly Finding[] =>
  floor?.strict === true && !required && skipWhy(floor, step) === undefined
    ? [strictUnrunFinding(step, reason, command)]
    : [];
