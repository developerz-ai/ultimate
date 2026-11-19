// `--only <step>[,<step>…]`, read once for every command that narrows the gate: `x verify --only`
// and `x upgrade --only` take the same list, refused the same way, so the two cannot disagree.

import { nearestName, renderFixShellArg } from '@ultimat3/core';
import { BadFlagError } from './errors';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import type { VerifyStepName } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

/** The commands whose `--only` narrows the gate; each refusal's `fix:` re-runs the one typed. */
export type StepListCommand = 'verify' | 'upgrade';

const isStepName = (raw: string): raw is VerifyStepName =>
  (VERIFY_STEP_NAMES as readonly string[]).includes(raw);

/**
 * The steps `--only` names, or nothing: one step (`--only lint`) or a comma-separated list
 * (`--only typecheck,lint,boundaries`), in the gate's declared order whatever order they were
 * typed in. Refused against `VERIFY_STEP_NAMES` — the same constant the runner's list is built
 * from — so a typo can never be read as "narrow to no steps at all", which is a run that passes by
 * checking nothing. An empty item (`lint,,drift`, a trailing comma) is refused for the same reason.
 *
 * A near miss leads with the list as it would be with each typo corrected; an item near NOTHING
 * gets the command itself rather than an invented lead, which is the rule `parse.ts` already
 * follows for a command that resembles none. Both arms are commands that run.
 */
export const readStepList = (
  args: ParsedArgs,
  command: StepListCommand,
): readonly VerifyStepName[] | undefined => {
  const raw = flagString(args, 'only');
  if (raw === undefined) return undefined;
  const items = raw.split(',').map((item) => item.trim());
  const unknown = items.filter((item) => !isStepName(item));
  if (unknown.length === 0) {
    return VERIFY_STEP_NAMES.filter((name) => items.includes(name));
  }
  // An empty item corrects to nothing — never to whichever step is nearest to ''.
  const corrected = items.map((item) =>
    isStepName(item) ? item : item === '' ? undefined : nearestName(item, VERIFY_STEP_NAMES),
  );
  const list = corrected.every((item) => item !== undefined)
    ? renderFixShellArg([...new Set(corrected)].join(','), '<step,step>')
    : undefined;
  throw new BadFlagError({
    flag: 'only',
    command,
    reason: `${reasonOf(unknown)} (${VERIFY_STEP_NAMES.join(', ')})`,
    fix: command === 'verify' ? verifyFix(list) : upgradeFix(list),
  });
};

// One literal per command: the command word never reaches a `fix:` as a spliced value.
const verifyFix = (list: string | undefined): string =>
  list === undefined ? 'x verify --json' : `x verify --only ${list} --json`;
const upgradeFix = (list: string | undefined): string =>
  list === undefined ? 'x upgrade --json' : `x upgrade --only ${list} --json`;

const reasonOf = (unknown: readonly string[]): string => {
  const named = unknown.map((item) => (item === '' ? '(empty)' : `"${item}"`)).join(', ');
  return `${named} ${unknown.length === 1 ? 'is not a gate step' : 'are not gate steps'}`;
};

/** The gate's steps a narrowed run leaves out, in declared order: what someone else still owes. */
export const stepsNotIn = (only: readonly string[]): readonly VerifyStepName[] =>
  VERIFY_STEP_NAMES.filter((name) => !only.includes(name));
