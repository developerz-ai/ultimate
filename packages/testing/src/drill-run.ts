// One drill, played: load on the web role, a `/readyz` sampler, the fault — proxy phases or a
// signal — then recovery, then the evidence folded and judged. The fleet is a parameter, so the
// sequence is proven against an in-process stand-in and `x drill` hands in the real one.

import { finiteCount } from '@ultimat3/core';
import type { DrillFleet } from './drill-fleet';
import { exitWithin } from './drill-fleet';
import type { DrillJobCounts, DrillSql } from './drill-jobs';
import { drillJobCounts } from './drill-jobs';
import type { DrillSample, DrillTarget } from './drill-load';
import { recoveryAfter, requestEvidence, startDrillLoad } from './drill-load';
import { sampleStatus } from './drill-probe';
import type { DrillSyncLane } from './drill-sync';
import type { DrillBudgets, DrillEvidence, DrillVerdict } from './drill-verdict';
import { judgeDrill } from './drill-verdict';
import type { Drill } from './drills';

export interface DrillRunOptions {
  readonly drill: Drill;
  readonly fleet: DrillFleet;
  readonly budgets: DrillBudgets & { readonly phaseMs: number };
  readonly targets: readonly DrillTarget[];
  /** The direct line to the scratch database, for the jobs evidence. */
  readonly sql: DrillSql;
  /** Load before the fault, so a drill that never had a 2xx says so rather than blaming the fault. */
  readonly baselineMs?: number | undefined;
  readonly sampleEveryMs?: number | undefined;
  readonly lanes?: number | undefined;
  /**
   * The sync-client lane, started with the fault and stopped after recovery — what `sync-resumes`
   * reads. Absent, that property is red on no evidence, never green on none.
   */
  readonly sync?: (() => DrillSyncLane) | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DrillReport {
  readonly name: string;
  readonly verdict: DrillVerdict;
  readonly evidence: DrillEvidence;
  readonly budgets: DrillBudgets;
  /** Answers before the fault began: a drill whose baseline failed is reporting the app, not it. */
  readonly baseline: { readonly ok: number; readonly failed: number };
}

interface Played {
  readonly clearedMs: number | undefined;
  readonly exit: DrillEvidence['exit'];
}

async function play(
  options: DrillRunOptions,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<Played> {
  const { drill, fleet, budgets } = options;
  const fault = drill.fault;
  if (fault.kind === 'service') {
    const proxy = fleet.proxies.get(fault.service);
    if (proxy === undefined) return { clearedMs: undefined, exit: undefined };
    for (const mode of fault.phases(budgets)) {
      await proxy.set(mode);
      await sleep(budgets.phaseMs);
    }
    await proxy.set({ kind: 'pass' });
    return { clearedMs: now(), exit: undefined };
  }
  const role = fleet.roles.get(fault.role);
  if (role === undefined) return { clearedMs: undefined, exit: undefined };
  const signalled = now();
  role.signal(fault.signal);
  const code = await exitWithin(role, budgets.drainMs);
  const exit = { role: fault.role, afterMs: code === null ? null : Math.round(now() - signalled) };
  // A worker comes back, as its supervisor would bring it: the run it held is reclaimed by it.
  if (fault.role === 'web') return { clearedMs: undefined, exit };
  await role.respawn();
  return { clearedMs: now(), exit };
}

const failedOf = (samples: readonly DrillSample[]): number =>
  samples.filter((sample) => sample.status === null || sample.status >= 300).length;

/** Play `drill` on `fleet` and judge it. Never throws for a property that did not hold. */
export async function runDrill(options: DrillRunOptions): Promise<DrillReport> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const { budgets, fleet, drill } = options;
  const [started] = await options.sql.rows('select now() as t', []);
  const since = started?.['t'];
  const load = startDrillLoad({
    base: fleet.base,
    targets: options.targets,
    lanes: options.lanes,
    requestBoundMs: budgets.deadlineMs * 2,
    now,
    sleep,
  });
  await sleep(finiteCount('runDrill', 'baselineMs', options.baselineMs ?? budgets.promptMs * 2));
  const baselineSamples = [...load.samples()];
  const zero = now();
  const web = fleet.roles.get('web');
  const sampler =
    web === undefined
      ? undefined
      : sampleStatus({
          url: web.readyz,
          everyMs: finiteCount('runDrill', 'sampleEveryMs', options.sampleEveryMs ?? 250, 1),
          boundMs: budgets.promptMs,
          zero,
          now,
          sleep,
        });
  const syncLane = options.sync?.();
  const played = await play(options, now, sleep);
  // Recovery is given its whole budget to show, and the load keeps measuring through it.
  if (played.clearedMs !== undefined) await sleep(budgets.recoveryMs);
  const samples = await load.stop();
  const readyz = await sampler?.stop();
  const sync = await syncLane?.stop();
  const jobs: DrillJobCounts | undefined =
    since instanceof Date
      ? await drillJobCounts({ sql: options.sql, since, settleMs: budgets.drainMs, now, sleep })
      : undefined;
  const evidence: DrillEvidence = {
    requests: requestEvidence(samples),
    readyz,
    recoveryMs:
      played.clearedMs === undefined ? undefined : recoveryAfter(samples, played.clearedMs),
    jobs,
    exit: played.exit,
    sync,
  };
  return {
    name: drill.name,
    verdict: judgeDrill(drill.holds, evidence, budgets),
    evidence,
    budgets,
    baseline: {
      ok: baselineSamples.length - failedOf(baselineSamples),
      failed: failedOf(baselineSamples),
    },
  };
}
