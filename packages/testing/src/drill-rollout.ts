// The rollout-order drill, played on a fleet started `beforeMigrate`: every role meets the behind
// schema — says so, or dies of it — is held a moment, then this release's migrate runs and each
// `/readyz` is asked until it answers. No load: the evidence is the roles', judged with the rest.

import { finiteCount } from '@ultimat3/core';
import type { DrillFleet } from './drill-fleet';
import { probeStatus } from './drill-probe';
import type { DrillRolloutRole } from './drill-rollout-verdict';
import type { DrillReport } from './drill-run';
import type { DrillBudgets, DrillEvidence } from './drill-verdict';
import { judgeDrill } from './drill-verdict';
import type { Drill } from './drills';

export interface DrillRolloutOptions {
  readonly drill: Drill;
  readonly fleet: DrillFleet;
  readonly budgets: DrillBudgets;
  /** A cold boot's bound: on the roles meeting the schema, and on each answering after migrate. */
  readonly readyTimeoutMs: number;
  /** How long every role must stay up once each has met the schema, before migrate starts. */
  readonly holdMs?: number | undefined;
  readonly probe?: ((url: string) => Promise<number | null>) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const POLL_MS = 250;
const PROBE_BOUND_MS = 1_000;
/** How much of a role's output the evidence carries: its last lines, where a refusal is. */
const LOG_TAIL_CHARS = 4_000;

const NOTHING: Omit<DrillEvidence, 'rollout'> = {
  requests: undefined,
  readyz: undefined,
  recoveryMs: undefined,
  jobs: undefined,
  exit: undefined,
  sync: undefined,
};

/** Play the rollout order on `fleet` and judge it. Never throws for a property that did not hold. */
export async function runRollout(options: DrillRolloutOptions): Promise<DrillReport> {
  const { drill, fleet, budgets } = options;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const probe = options.probe ?? ((url: string) => probeStatus(url, PROBE_BOUND_MS));
  const boundMs = finiteCount('runRollout', 'readyTimeoutMs', options.readyTimeoutMs, 1);
  const until = async (done: () => boolean | Promise<boolean>): Promise<void> => {
    for (let waited = 0; waited < boundMs; waited += POLL_MS) {
      if (await done()) return;
      await sleep(POLL_MS);
    }
  };
  const report = (evidence: DrillEvidence): DrillReport => ({
    name: drill.name,
    verdict: judgeDrill(drill.holds, evidence, budgets),
    evidence,
    budgets,
    baseline: { ok: 0, failed: 0 },
  });
  const rollout = fleet.rollout;
  // A fleet started without `beforeMigrate` had its roles migrated first: nothing to measure.
  if (rollout === undefined) return report(NOTHING);
  const roles = [...fleet.roles.values()];
  const exitOf = (role: (typeof roles)[number]) => rollout.exitCode(role.role);
  await until(() => roles.every((role) => exitOf(role) !== null || rollout.watched(role.role) > 0));
  await sleep(finiteCount('runRollout', 'holdMs', options.holdMs ?? 3_000));
  await rollout.migrate();
  const measured: DrillRolloutRole[] = [];
  for (const role of roles) {
    // A dead role ends its own wait: it will never answer.
    let ready = false;
    await until(async () => {
      if (exitOf(role) !== null) return true;
      ready = (await probe(role.readyz)) === 200;
      return ready;
    });
    measured.push({
      role: role.role,
      // Read after the wait: a role that died during migrate crash-looped all the same.
      exit: ready ? null : exitOf(role),
      ready,
      waitLines: rollout.watched(role.role),
      logTail: role.log().slice(-LOG_TAIL_CHARS),
    });
  }
  return report({ ...NOTHING, rollout: { roles: measured } });
}
