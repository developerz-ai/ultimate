// Every drill property holds on evidence that satisfies it and fails on evidence that violates it,
// and a property with no evidence is red — never a vacuous green.

import { describe, expect, test } from 'bun:test';
import type { DrillBudgets, DrillEvidence, DrillProperty } from './drill-verdict';
import { DRILL_ANSWER_SLACK_MS, DRILL_PROPERTIES, judgeDrill } from './drill-verdict';

const budgets: DrillBudgets = {
  deadlineMs: 1_000,
  promptMs: 200,
  recoveryMs: 1_000,
  readinessMs: 500,
  drainMs: 2_000,
  readiness: 'dependencies',
};

const healthy: DrillEvidence = {
  requests: {
    ok: 10,
    failedByCode: new Map([['X_DB_UNAVAILABLE', 2]]),
    uncoded: 0,
    unanswered: 0,
    maxMs: 150,
  },
  readyz: [
    { atMs: 0, status: 200 },
    { atMs: 300, status: 503 },
    { atMs: 900, status: 200 },
  ],
  recoveryMs: 400,
  jobs: { ran: 3, stuck: 0, doubled: 0 },
  exit: { role: 'worker', afterMs: 800 },
  sync: { reconnected: true, gaps: 0 },
};

const failsOn = (
  property: DrillProperty,
  evidence: DrillEvidence,
  over: Partial<DrillBudgets> = {},
) =>
  judgeDrill([property], evidence, { ...budgets, ...over }).failures.map(
    (failure) => failure.property,
  );

describe('judgeDrill', () => {
  test('healthy evidence holds every property but requests-ok, which a coded 5xx breaks', () => {
    const verdict = judgeDrill(DRILL_PROPERTIES, healthy, budgets);
    expect(verdict.failures.map((failure) => failure.property)).toEqual(['requests-ok']);
  });

  test('a drill that states nothing is never ok', () => {
    expect(judgeDrill([], healthy, budgets).ok).toBe(false);
  });

  test('every property is red on no evidence', () => {
    const none: DrillEvidence = {
      requests: undefined,
      readyz: undefined,
      recoveryMs: undefined,
      jobs: undefined,
      exit: undefined,
      sync: undefined,
    };
    const verdict = judgeDrill(DRILL_PROPERTIES, none, budgets);
    expect(verdict.failures.map((failure) => failure.property)).toEqual([...DRILL_PROPERTIES]);
    expect(verdict.failures.every((failure) => failure.observed.startsWith('no evidence'))).toBe(
      true,
    );
  });

  test('requests-coded: an uncoded 5xx is always red, and so is a drill that sent nothing', () => {
    const requests = healthy.requests ?? expect.unreachable();
    expect(
      failsOn('requests-coded', { ...healthy, requests: { ...requests, uncoded: 1 } }),
    ).toEqual(['requests-coded']);
    const empty = { ok: 0, failedByCode: new Map(), uncoded: 0, unanswered: 0, maxMs: 0 };
    expect(failsOn('requests-coded', { ...healthy, requests: empty })).toEqual(['requests-coded']);
    expect(failsOn('requests-coded', healthy)).toEqual([]);
  });

  test('requests-bounded: past the deadline, or never answered', () => {
    const requests = healthy.requests ?? expect.unreachable();
    expect(
      failsOn('requests-bounded', {
        ...healthy,
        requests: { ...requests, maxMs: 1_001 + DRILL_ANSWER_SLACK_MS },
      }),
    ).toEqual(['requests-bounded']);
    // Answered BY the deadline: the 504 the deadline fires reaches the load a beat after it.
    expect(
      failsOn('requests-bounded', {
        ...healthy,
        requests: { ...requests, maxMs: 1_000 + DRILL_ANSWER_SLACK_MS },
      }),
    ).toEqual([]);
    expect(
      failsOn('requests-bounded', { ...healthy, requests: { ...requests, unanswered: 1 } }),
    ).toEqual(['requests-bounded']);
    expect(failsOn('requests-bounded', healthy)).toEqual([]);
  });

  test('requests-prompt: one bounded delay and no more', () => {
    const requests = healthy.requests ?? expect.unreachable();
    expect(
      failsOn('requests-prompt', { ...healthy, requests: { ...requests, maxMs: 201 } }),
    ).toEqual(['requests-prompt']);
    expect(failsOn('requests-prompt', healthy)).toEqual([]);
  });

  test('requests-ok: any non-2xx answer, or no answer at all', () => {
    const requests = healthy.requests ?? expect.unreachable();
    const clean = { ...requests, failedByCode: new Map<string, number>() };
    expect(failsOn('requests-ok', { ...healthy, requests: clean })).toEqual([]);
    expect(failsOn('requests-ok', { ...healthy, requests: { ...clean, uncoded: 1 } })).toEqual([
      'requests-ok',
    ]);
    expect(failsOn('requests-ok', { ...healthy, requests: { ...clean, ok: 0 } })).toEqual([
      'requests-ok',
    ]);
  });

  test('recovers: none after the fault, or one past the budget', () => {
    expect(failsOn('recovers', { ...healthy, recoveryMs: null })).toEqual(['recovers']);
    expect(failsOn('recovers', { ...healthy, recoveryMs: 1_001 })).toEqual(['recovers']);
    expect(failsOn('recovers', healthy)).toEqual([]);
  });

  test('readyz-flips: a 503 inside the interval, then 200 again', () => {
    expect(failsOn('readyz-flips', { ...healthy, readyz: [{ atMs: 0, status: 200 }] })).toEqual([
      'readyz-flips',
    ]);
    const late = [
      { atMs: 600, status: 503 },
      { atMs: 900, status: 200 },
    ];
    expect(failsOn('readyz-flips', { ...healthy, readyz: late })).toEqual(['readyz-flips']);
    const stuck = [
      { atMs: 100, status: 503 },
      { atMs: 900, status: null },
    ];
    expect(failsOn('readyz-flips', { ...healthy, readyz: stuck })).toEqual(['readyz-flips']);
    expect(failsOn('readyz-flips', healthy)).toEqual([]);
  });

  test("readyz-flips under health.readiness 'process': a 503 is the failure", () => {
    expect(failsOn('readyz-flips', healthy, { readiness: 'process' })).toEqual(['readyz-flips']);
    const steady = [
      { atMs: 0, status: 200 },
      { atMs: 500, status: 200 },
    ];
    expect(
      failsOn('readyz-flips', { ...healthy, readyz: steady }, { readiness: 'process' }),
    ).toEqual([]);
  });

  test('jobs-terminal: a stuck job, or no job to prove anything with', () => {
    expect(
      failsOn('jobs-terminal', { ...healthy, jobs: { ran: 3, stuck: 1, doubled: 0 } }),
    ).toEqual(['jobs-terminal']);
    expect(
      failsOn('jobs-terminal', { ...healthy, jobs: { ran: 0, stuck: 0, doubled: 0 } }),
    ).toEqual(['jobs-terminal']);
    expect(failsOn('jobs-terminal', healthy)).toEqual([]);
  });

  test('jobs-once: a key completed twice', () => {
    expect(failsOn('jobs-once', { ...healthy, jobs: { ran: 3, stuck: 0, doubled: 1 } })).toEqual([
      'jobs-once',
    ]);
    expect(failsOn('jobs-once', healthy)).toEqual([]);
  });

  test('role-exits: never, or past the drain', () => {
    expect(failsOn('role-exits', { ...healthy, exit: { role: 'web', afterMs: null } })).toEqual([
      'role-exits',
    ]);
    expect(failsOn('role-exits', { ...healthy, exit: { role: 'web', afterMs: 2_001 } })).toEqual([
      'role-exits',
    ]);
    expect(failsOn('role-exits', healthy)).toEqual([]);
  });

  test('sync-resumes: no reconnect, or a gap', () => {
    expect(failsOn('sync-resumes', { ...healthy, sync: { reconnected: false, gaps: 0 } })).toEqual([
      'sync-resumes',
    ]);
    expect(failsOn('sync-resumes', { ...healthy, sync: { reconnected: true, gaps: 2 } })).toEqual([
      'sync-resumes',
    ]);
    expect(failsOn('sync-resumes', healthy)).toEqual([]);
  });
});
