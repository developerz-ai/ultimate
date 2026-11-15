// The drill table: each drill's fault and the framework contracts that must hold through it. Data
// only — `drill-run.ts` plays a fault, `drill-verdict.ts` judges what was measured. Never an app's
// business rule: every property is one the framework declares for every app the same.

import type { DrillBudgets, DrillProperty } from './drill-verdict';
import type { FaultMode } from './fault-proxy';

/** A service a drill puts a fault proxy in front of. */
export type DrillService = 'postgres' | 'redis' | 'nats';

/**
 * A role the fleet runs as its own process (`ROLE`, `apps/web/server.ts`); `sync` only for a drill
 * whose sync client needs a node to dial, `scheduler` only for the rollout-order drill.
 */
export type DrillRole = 'web' | 'worker' | 'sync' | 'scheduler';

export type DrillName =
  | 'pg-blackhole'
  | 'pg-slow'
  | 'pg-restart'
  | 'redis-down'
  | 'nats-down'
  | 'worker-sigkill'
  | 'worker-sigterm'
  | 'web-sigterm'
  | 'roll-before-migrate';

/**
 * The fault itself: a proxy mode per phase, a signal to one role's process, or the rollout order —
 * the roles started before this release's migrate, on a schema an older build stamped, each to say
 * so in one line naming `waitCode` (`drill-rollout.ts`).
 */
export type DrillFault =
  | {
      readonly kind: 'service';
      readonly service: DrillService;
      /** Played in order, each for one phase; `pass` follows, and recovery is timed from it. */
      readonly phases: (budgets: DrillBudgets) => readonly FaultMode[];
    }
  | { readonly kind: 'signal'; readonly role: DrillRole; readonly signal: 'SIGKILL' | 'SIGTERM' }
  | { readonly kind: 'order'; readonly waitCode: string };

export interface Drill {
  readonly name: DrillName;
  readonly fault: DrillFault;
  readonly holds: readonly DrillProperty[];
}

/** Past the statement ceiling and short of the request deadline: slow, never dead. */
const slowStatementMs = (budgets: DrillBudgets): number => Math.floor(budgets.deadlineMs / 2);

export const DRILLS: readonly Drill[] = [
  {
    name: 'pg-blackhole',
    fault: { kind: 'service', service: 'postgres', phases: () => [{ kind: 'blackhole' }] },
    holds: ['requests-coded', 'requests-bounded', 'recovers', 'jobs-once'],
  },
  {
    name: 'pg-slow',
    fault: {
      kind: 'service',
      service: 'postgres',
      phases: (budgets) => [{ kind: 'delay', ms: slowStatementMs(budgets) }],
    },
    holds: ['requests-coded', 'requests-bounded', 'recovers'],
  },
  {
    name: 'pg-restart',
    fault: {
      kind: 'service',
      service: 'postgres',
      phases: () => [{ kind: 'reset' }, { kind: 'refuse' }],
    },
    holds: ['requests-coded', 'readyz-flips', 'recovers', 'jobs-once'],
  },
  {
    name: 'redis-down',
    fault: { kind: 'service', service: 'redis', phases: () => [{ kind: 'blackhole' }] },
    holds: ['requests-coded', 'requests-prompt', 'requests-ok', 'recovers'],
  },
  {
    name: 'nats-down',
    fault: { kind: 'service', service: 'nats', phases: () => [{ kind: 'refuse' }] },
    holds: ['requests-coded', 'recovers', 'sync-resumes'],
  },
  {
    name: 'worker-sigkill',
    fault: { kind: 'signal', role: 'worker', signal: 'SIGKILL' },
    holds: ['jobs-terminal', 'jobs-once', 'requests-coded'],
  },
  {
    name: 'worker-sigterm',
    fault: { kind: 'signal', role: 'worker', signal: 'SIGTERM' },
    holds: ['role-exits', 'jobs-terminal', 'jobs-once'],
  },
  {
    name: 'web-sigterm',
    fault: { kind: 'signal', role: 'web', signal: 'SIGTERM' },
    holds: ['requests-ok', 'role-exits'],
  },
  {
    name: 'roll-before-migrate',
    fault: { kind: 'order', waitCode: 'X_FRAMEWORK_SCHEMA_UNAPPLIED' },
    holds: ['roles-wait', 'serves-after-migrate', 'one-wait-line'],
  },
];

export const DRILL_NAMES: readonly DrillName[] = DRILLS.map((drill) => drill.name);

/** The drill named `name`, or `undefined`: the caller refuses with the list. */
export const drillNamed = (name: string): Drill | undefined =>
  DRILLS.find((drill) => drill.name === name);

/**
 * The roles a drill's fleet runs: a sync client needs the sync node it dials; the rollout order is
 * played on every role Postgres alone serves (`replicator` needs a logical server, `sync` a bus).
 */
export const drillRoles = (drill: Drill): readonly DrillRole[] => {
  if (drill.fault.kind === 'order') return ['web', 'worker', 'scheduler'];
  return drill.holds.includes('sync-resumes') ? ['web', 'worker', 'sync'] : ['web', 'worker'];
};

/** The service a drill needs running, when it needs one beyond Postgres. */
export const drillService = (drill: Drill): DrillService | undefined =>
  drill.fault.kind === 'service' ? drill.fault.service : undefined;
