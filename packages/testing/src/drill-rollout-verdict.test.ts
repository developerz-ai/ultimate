// `roll-before-migrate`'s three properties over evidence: a role that exits while the schema is
// behind is a crash-loop, a role that never answers after migrate is not serving, and the wait is
// said once per role. A boot that refuses at once and exits is red on all three.

import { describe, expect, test } from 'bun:test';
import { drillBudgets } from './drill-budgets';
import type { DrillRolloutRole } from './drill-rollout-verdict';
import type { DrillEvidence } from './drill-verdict';
import { judgeDrill } from './drill-verdict';

const HOLDS = ['roles-wait', 'serves-after-migrate', 'one-wait-line'] as const;

const budgets = drillBudgets({
  requestTimeoutMs: 4_000,
  drainDeadlineMs: 5_000,
  readinessGraceMs: 0,
  readiness: 'dependencies',
});

const waited = (role: DrillRolloutRole['role']): DrillRolloutRole => ({
  role,
  exit: null,
  ready: true,
  waitLines: 1,
  logTail: '{"code":"X_FRAMEWORK_SCHEMA_UNAPPLIED"}',
});

const judged = (roles: readonly DrillRolloutRole[] | undefined) => {
  const evidence: DrillEvidence = {
    requests: undefined,
    readyz: undefined,
    recoveryMs: undefined,
    jobs: undefined,
    exit: undefined,
    sync: undefined,
    rollout: roles === undefined ? undefined : { roles },
  };
  return judgeDrill(HOLDS, evidence, budgets);
};

const properties = (roles: readonly DrillRolloutRole[] | undefined) =>
  judged(roles).failures.map((failure) => failure.property);

describe('roll-before-migrate verdict', () => {
  test('every role waited, said so once and served after migrate: held', () => {
    expect(judged([waited('web'), waited('worker'), waited('scheduler')])).toEqual({
      ok: true,
      failures: [],
    });
  });

  test('a boot that refuses at once and exits is red on all three', () => {
    const refused: DrillRolloutRole = {
      role: 'worker',
      exit: 1,
      ready: false,
      waitLines: 2,
      logTail: 'error: boot failed\n    code: "X_FRAMEWORK_SCHEMA_UNAPPLIED"\n',
    };
    const verdict = judged([waited('web'), refused]);
    expect(verdict.failures.map((failure) => failure.property)).toEqual([...HOLDS]);
    expect(verdict.failures[0]?.observed).toContain('ROLE=worker exited 1');
    expect(verdict.failures[0]?.observed).toContain('code: "X_FRAMEWORK_SCHEMA_UNAPPLIED"');
  });

  test('a role that waited without a word is red on its own', () => {
    expect(properties([waited('worker'), { ...waited('web'), waitLines: 0 }])).toEqual([
      'one-wait-line',
    ]);
  });

  test('a repeated wait line is red, naming every count', () => {
    const verdict = judged([waited('web'), { ...waited('scheduler'), waitLines: 3 }]);
    expect(verdict.failures[0]?.observed).toBe('ROLE=web 1, ROLE=scheduler 3');
  });

  test('a role still up but never ready after migrate is not serving', () => {
    expect(properties([{ ...waited('scheduler'), ready: false }])).toEqual([
      'serves-after-migrate',
    ]);
  });

  test('no rollout measured, or no role in it, is no evidence — never a pass', () => {
    expect(properties(undefined)).toEqual([...HOLDS]);
    expect(properties([])).toEqual([...HOLDS]);
  });
});
