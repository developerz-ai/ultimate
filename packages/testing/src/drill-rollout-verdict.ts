// The rollout-order drill's three properties, judged over what `runRollout` measured per role: it
// stayed up while the schema was behind, it served once migrate ran, and it said it waited exactly
// once. Pure, beside `drill-verdict.ts`, which holds every judge in its one table.

import type { DrillEvidence, DrillFailure } from './drill-verdict';

/** One role through the rollout: started before migrate, asked for `/readyz` after it. */
export interface DrillRolloutRole {
  readonly role: string;
  /** The exit code when the process ended before it answered ready; `null` while it stayed up. */
  readonly exit: number | null;
  /** `/readyz` answered 200 once migrate had run. */
  readonly ready: boolean;
  /** Output lines naming the drill's wait code, counted as they streamed. */
  readonly waitLines: number;
  /** The last of the role's output: where a refusal is. */
  readonly logTail: string;
}

export interface DrillRolloutEvidence {
  readonly roles: readonly DrillRolloutRole[];
}

type RolloutJudge = (evidence: DrillEvidence) => DrillFailure | undefined;

const NO_ROLES = 'no evidence: no role was started before migrate';

/** The line a role exited on: its last line naming a code, else its last line. */
const lastWords = (log: string): string => {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.findLast((line) => line.includes('X_')) ?? lines.at(-1) ?? '(no output)';
};

/** The roles measured, or `undefined` when there is nothing to judge. */
const rolesOf = (evidence: DrillEvidence): readonly DrillRolloutRole[] | undefined => {
  const roles = evidence.rollout?.roles;
  return roles === undefined || roles.length === 0 ? undefined : roles;
};

export const judgeRolesWait: RolloutJudge = (evidence) => {
  const expected = 'every role stays up while the schema is behind (no crash-loop)';
  const roles = rolesOf(evidence);
  if (roles === undefined) return { property: 'roles-wait', expected, observed: NO_ROLES };
  const exited = roles.filter((role) => role.exit !== null);
  if (exited.length === 0) return undefined;
  return {
    property: 'roles-wait',
    expected,
    observed: exited
      .map((role) => `ROLE=${role.role} exited ${String(role.exit)}: ${lastWords(role.logTail)}`)
      .join('; '),
  };
};

export const judgeServesAfterMigrate: RolloutJudge = (evidence) => {
  const expected = 'every role answers /readyz 200 once ROLE=migrate has run';
  const roles = rolesOf(evidence);
  if (roles === undefined)
    return { property: 'serves-after-migrate', expected, observed: NO_ROLES };
  const unready = roles.filter((role) => !role.ready);
  if (unready.length === 0) return undefined;
  return {
    property: 'serves-after-migrate',
    expected,
    observed: `never ready: ${unready.map((role) => `ROLE=${role.role}`).join(', ')}`,
  };
};

export const judgeOneWaitLine: RolloutJudge = (evidence) => {
  const expected = 'exactly one log line per role naming the wait code while it waits';
  const roles = rolesOf(evidence);
  if (roles === undefined) return { property: 'one-wait-line', expected, observed: NO_ROLES };
  if (roles.every((role) => role.waitLines === 1)) return undefined;
  return {
    property: 'one-wait-line',
    expected,
    observed: roles.map((role) => `ROLE=${role.role} ${String(role.waitLines)}`).join(', '),
  };
};
