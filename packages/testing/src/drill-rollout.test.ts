// `runRollout` against a stand-in fleet: it waits for every role to meet the behind schema, runs
// migrate, then asks each `/readyz` — and a role that died, or a fleet started without the rollout
// handle, is evidence for red, never a pass.

import { describe, expect, test } from 'bun:test';
import { drillBudgets } from './drill-budgets';
import type { DrillFleet, DrillRoleProcess, DrillRollout } from './drill-fleet';
import { runRollout } from './drill-rollout';
import type { DrillRole } from './drills';
import { drillNamed } from './drills';

const drill = drillNamed('roll-before-migrate') ?? expect.unreachable('the drill is in the table');

const budgets = drillBudgets({
  requestTimeoutMs: 4_000,
  drainDeadlineMs: 5_000,
  readinessGraceMs: 0,
  readiness: 'dependencies',
});

const ROLES: readonly DrillRole[] = ['web', 'worker', 'scheduler'];

interface Script {
  /** The role exits with this code as soon as it meets the schema. */
  readonly dies?: DrillRole;
  readonly lines?: number;
}

function standIn(script: Script) {
  const order: string[] = [];
  let migrated = false;
  const role = (name: DrillRole): DrillRoleProcess => ({
    role: name,
    origin: `http://${name}`,
    readyz: `http://${name}/readyz`,
    signal: () => undefined,
    exited: async () => 0,
    respawn: async () => expect.unreachable('a rollout never respawns'),
    log: () => `log of ${name}`,
  });
  const rollout: DrillRollout = {
    migrate: async () => {
      order.push('migrate');
      migrated = true;
    },
    exitCode: (name) => (name === script.dies ? 1 : null),
    watched: () => script.lines ?? 1,
  };
  const fleet: DrillFleet = {
    base: 'http://web',
    databaseUrl: 'postgres://unused',
    proxies: new Map(),
    roles: new Map(ROLES.map((name) => [name, role(name)])),
    rollout,
    stop: async () => undefined,
  };
  const probe = async (url: string): Promise<number | null> => {
    order.push(`probe ${url}`);
    return migrated ? 200 : 503;
  };
  return { fleet, order, probe };
}

const run = (fleet: DrillFleet, probe: (url: string) => Promise<number | null>) =>
  runRollout({
    drill,
    fleet,
    budgets,
    readyTimeoutMs: 1_000,
    holdMs: 1,
    probe,
    sleep: () => Bun.sleep(1),
  });

describe('runRollout', () => {
  test('every role waits, migrate runs, every role then answers: held', async () => {
    const { fleet, order, probe } = standIn({});
    const report = await run(fleet, probe);
    expect(report.verdict).toEqual({ ok: true, failures: [] });
    expect(order[0]).toBe('migrate');
    expect(report.evidence.rollout?.roles.map((role) => role.role)).toEqual([...ROLES]);
    expect(report.evidence.rollout?.roles[0]?.logTail).toBe('log of web');
  });

  test('a role that exits while waiting is a crash-loop, and is never asked for /readyz', async () => {
    const { fleet, order, probe } = standIn({ dies: 'worker' });
    const report = await run(fleet, probe);
    expect(report.verdict.failures.map((failure) => failure.property)).toEqual([
      'roles-wait',
      'serves-after-migrate',
    ]);
    expect(order).not.toContain('probe http://worker/readyz');
  });

  test('two wait lines from each role is red', async () => {
    const { fleet, probe } = standIn({ lines: 2 });
    const report = await run(fleet, probe);
    expect(report.verdict.failures.map((failure) => failure.property)).toEqual(['one-wait-line']);
  });

  test('the readiness bound is time, not sleeps: a probe that takes its whole bound counts', async () => {
    const { fleet } = standIn({});
    // A virtual monotonic clock: every sleep and every probe advances it by what it would take.
    let clock = 0;
    let probes = 0;
    const report = await runRollout({
      drill,
      fleet,
      budgets,
      readyTimeoutMs: 2_000,
      holdMs: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      probe: async () => {
        probes += 1;
        clock += 1_000;
        return 503;
      },
    });
    expect(report.verdict.failures.map((failure) => failure.property)).toEqual([
      'serves-after-migrate',
    ]);
    // Inside 2,000 ms a 1,000 ms probe and a 250 ms poll fit twice per role, never eight times.
    expect(probes).toBeLessThanOrEqual(3 * 2);
  });

  test('a fleet started without the rollout handle measured nothing: red, not a pass', async () => {
    const { fleet, probe } = standIn({});
    const { rollout: _rollout, ...bare } = fleet;
    const report = await run(bare, probe);
    expect(report.verdict.ok).toBe(false);
    expect(report.evidence.rollout).toBeUndefined();
  });
});
