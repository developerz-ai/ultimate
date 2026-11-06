// A drill's verdict, over evidence only: what the load saw, what `/readyz` answered, what the jobs
// tables hold, how long recovery took. Pure, so every property is proven red on evidence that
// violates it without a service running. A property with no evidence is red too: a drill that
// measured nothing is the vacuous pass this file exists to refuse.

/** Every property a drill may state. The table (`drills.ts`) picks; this file judges. */
export type DrillProperty =
  | 'requests-coded'
  | 'requests-bounded'
  | 'requests-prompt'
  | 'requests-ok'
  | 'recovers'
  | 'readyz-flips'
  | 'jobs-terminal'
  | 'jobs-once'
  | 'role-exits'
  | 'sync-resumes';

/** The thresholds, each derived from the app's config (`drillBudgets`), never typed per drill. */
export interface DrillBudgets {
  /** The request deadline (`requestTimeoutMs`), or `--budget-ms`. A request past it is red. */
  readonly deadlineMs: number;
  /** One bounded delay: a degraded dependency may cost a read this much, and no more. */
  readonly promptMs: number;
  /** From the fault cleared to the first answered request, with no restart. */
  readonly recoveryMs: number;
  /** How long `/readyz` may take to say 503 once a dependency is gone. */
  readonly readinessMs: number;
  /** `drain.deadlineMs` plus the readiness grace: a signalled role is gone inside it. */
  readonly drainMs: number;
  /** `health.readiness`: `'process'` keeps `/readyz` 200 through a dependency outage, by design. */
  readonly readiness: 'dependencies' | 'process';
  /** `--budget-ms`, when given: printed in the verdict, because it replaced the derived deadline. */
  readonly override?: number | undefined;
}

export interface DrillRequestEvidence {
  readonly ok: number;
  /** Non-2xx answers carrying a framework `X_*` code, by code. */
  readonly failedByCode: ReadonlyMap<string, number>;
  /** Non-2xx answers with no code, or `X_INTERNAL` — a failure the framework did not classify. */
  readonly uncoded: number;
  /** Requests nothing answered: the connection refused, reset or the harness's own bound hit. */
  readonly unanswered: number;
  /** The slowest answered request, in ms. */
  readonly maxMs: number;
}

export interface DrillEvidence {
  readonly requests: DrillRequestEvidence | undefined;
  /** Each `/readyz` sample: ms since the fault began, and the status (`null`: nothing answered). */
  readonly readyz: readonly { readonly atMs: number; readonly status: number | null }[] | undefined;
  /** From the fault cleared to the first 2xx; `null` when none came. */
  readonly recoveryMs: number | null | undefined;
  readonly jobs:
    | { readonly ran: number; readonly stuck: number; readonly doubled: number }
    | undefined;
  /** The signalled role: ms from the signal to its exit, `null` when it never exited. */
  readonly exit: { readonly role: string; readonly afterMs: number | null } | undefined;
  readonly sync: { readonly reconnected: boolean; readonly gaps: number } | undefined;
}

export interface DrillFailure {
  readonly property: DrillProperty;
  readonly expected: string;
  readonly observed: string;
}

export interface DrillVerdict {
  readonly ok: boolean;
  readonly failures: readonly DrillFailure[];
}

type Judge = (evidence: DrillEvidence, budgets: DrillBudgets) => DrillFailure | undefined;

const NO_EVIDENCE = 'no evidence: the drill did not measure it';

/**
 * How late past the deadline an answer may reach the load and still be one the deadline gave: the
 * load times from before `fetch`, so the 504 a deadline fires arrives a beat after it (measured:
 * 30,002 ms on a 30,000 ms deadline). A request nothing bounded runs to the load's own bound.
 */
export const DRILL_ANSWER_SLACK_MS = 500;

const fail = (property: DrillProperty, expected: string, observed: string): DrillFailure => ({
  property,
  expected,
  observed,
});

const codes = (requests: DrillRequestEvidence): string =>
  [...requests.failedByCode].map(([code, count]) => `${code}×${String(count)}`).join(', ') ||
  'none';

const failedCount = (requests: DrillRequestEvidence): number =>
  requests.uncoded + [...requests.failedByCode.values()].reduce((sum, count) => sum + count, 0);

const JUDGES: ReadonlyMap<DrillProperty, Judge> = new Map<DrillProperty, Judge>([
  [
    'requests-coded',
    ({ requests }) => {
      const expected = 'every failed request answered with an X_* code';
      if (requests === undefined) return fail('requests-coded', expected, NO_EVIDENCE);
      if (requests.ok + requests.unanswered + failedCount(requests) === 0) {
        return fail('requests-coded', expected, 'no request was sent');
      }
      return requests.uncoded === 0
        ? undefined
        : fail('requests-coded', expected, `${String(requests.uncoded)} uncoded 5xx or X_INTERNAL`);
    },
  ],
  [
    'requests-bounded',
    ({ requests }, budgets) => {
      const expected = `every request answered within the ${String(budgets.deadlineMs)} ms deadline`;
      if (requests === undefined) return fail('requests-bounded', expected, NO_EVIDENCE);
      if (requests.unanswered > 0) {
        return fail('requests-bounded', expected, `${String(requests.unanswered)} never answered`);
      }
      return requests.maxMs <= budgets.deadlineMs + DRILL_ANSWER_SLACK_MS
        ? undefined
        : fail('requests-bounded', expected, `slowest ${String(requests.maxMs)} ms`);
    },
  ],
  [
    'requests-prompt',
    ({ requests }, budgets) => {
      const expected = `no request held past one bounded delay, ${String(budgets.promptMs)} ms`;
      if (requests === undefined) return fail('requests-prompt', expected, NO_EVIDENCE);
      return requests.maxMs <= budgets.promptMs && requests.unanswered === 0
        ? undefined
        : fail(
            'requests-prompt',
            expected,
            `slowest ${String(requests.maxMs)} ms, ${String(requests.unanswered)} unanswered`,
          );
    },
  ],
  [
    'requests-ok',
    ({ requests }) => {
      const expected = 'every request accepted was answered 2xx';
      if (requests === undefined) return fail('requests-ok', expected, NO_EVIDENCE);
      const failed = failedCount(requests);
      if (requests.ok === 0) return fail('requests-ok', expected, 'no request was answered');
      return failed === 0
        ? undefined
        : fail('requests-ok', expected, `${String(failed)} non-2xx: ${codes(requests)}`);
    },
  ],
  [
    'recovers',
    ({ recoveryMs }, budgets) => {
      const expected = `a 2xx within ${String(budgets.recoveryMs)} ms of the fault clearing, no restart`;
      if (recoveryMs === undefined) return fail('recovers', expected, NO_EVIDENCE);
      if (recoveryMs === null) return fail('recovers', expected, 'no 2xx after the fault cleared');
      return recoveryMs <= budgets.recoveryMs
        ? undefined
        : fail('recovers', expected, `first 2xx after ${String(recoveryMs)} ms`);
    },
  ],
  ['readyz-flips', judgeReadyz],
  [
    'jobs-terminal',
    ({ jobs }) => {
      const expected = 'every job the drill saw reached a terminal state';
      if (jobs === undefined) return fail('jobs-terminal', expected, NO_EVIDENCE);
      if (jobs.ran === 0) return fail('jobs-terminal', expected, 'no job ran during the drill');
      return jobs.stuck === 0
        ? undefined
        : fail('jobs-terminal', expected, `${String(jobs.stuck)} of ${String(jobs.ran)} stuck`);
    },
  ],
  [
    'jobs-once',
    ({ jobs }) => {
      const expected = 'no job run twice for one idempotency key';
      if (jobs === undefined) return fail('jobs-once', expected, NO_EVIDENCE);
      return jobs.doubled === 0
        ? undefined
        : fail('jobs-once', expected, `${String(jobs.doubled)} key(s) ran twice`);
    },
  ],
  [
    'role-exits',
    ({ exit }, budgets) => {
      const expected = `the signalled role exits within its drain, ${String(budgets.drainMs)} ms`;
      if (exit === undefined) return fail('role-exits', expected, NO_EVIDENCE);
      if (exit.afterMs === null) return fail('role-exits', expected, `${exit.role} never exited`);
      return exit.afterMs <= budgets.drainMs
        ? undefined
        : fail('role-exits', expected, `${exit.role} exited after ${String(exit.afterMs)} ms`);
    },
  ],
  [
    'sync-resumes',
    ({ sync }) => {
      const expected = 'sync clients reconnected and resynced with no sequence gap';
      if (sync === undefined) return fail('sync-resumes', expected, NO_EVIDENCE);
      if (!sync.reconnected) return fail('sync-resumes', expected, 'a client never reconnected');
      return sync.gaps === 0
        ? undefined
        : fail('sync-resumes', expected, `${String(sync.gaps)} sequence gap(s)`);
    },
  ],
]);

/**
 * `dependencies`: 503 within `readinessMs` of the fault, and 200 again by the last sample.
 * `process`: 200 throughout — the app declared that one dependency must not empty the fleet.
 */
function judgeReadyz(evidence: DrillEvidence, budgets: DrillBudgets): DrillFailure | undefined {
  const samples = evidence.readyz;
  const flips = budgets.readiness === 'dependencies';
  const expected = flips
    ? `/readyz 503 within ${String(budgets.readinessMs)} ms of the fault, then 200 again`
    : '/readyz 200 throughout (health.readiness is process)';
  if (samples === undefined || samples.length === 0) {
    return fail('readyz-flips', expected, NO_EVIDENCE);
  }
  const last = samples[samples.length - 1];
  const statuses = samples.map((sample) => String(sample.status ?? 'none')).join(',');
  if (!flips) {
    return samples.every((sample) => sample.status === 200)
      ? undefined
      : fail('readyz-flips', expected, `statuses ${statuses}`);
  }
  const down = samples.find((sample) => sample.status === 503);
  if (down === undefined || down.atMs > budgets.readinessMs) {
    return fail(
      'readyz-flips',
      expected,
      `first 503 at ${down === undefined ? 'never' : `${String(down.atMs)} ms`}`,
    );
  }
  return last?.status === 200
    ? undefined
    : fail('readyz-flips', expected, `last sample ${String(last?.status ?? 'none')}`);
}

/** Every stated property, judged; `ok` only when none failed and at least one was stated. */
export function judgeDrill(
  holds: readonly DrillProperty[],
  evidence: DrillEvidence,
  budgets: DrillBudgets,
): DrillVerdict {
  const failures: DrillFailure[] = [];
  for (const property of holds) {
    const failure = JUDGES.get(property)?.(evidence, budgets);
    if (failure !== undefined) failures.push(failure);
  }
  return { ok: holds.length > 0 && failures.length === 0, failures };
}

/** The properties this file knows how to judge — what the drill table is held to. */
export const DRILL_PROPERTIES: readonly DrillProperty[] = [...JUDGES.keys()];
