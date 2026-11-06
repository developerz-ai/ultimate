// `runDrill` on its own clock and sleep, against a fleet that holds none of what the drill faults:
// nothing is played, nothing is sampled, and the verdict is red on the missing evidence — a drill
// never reads green because it had nothing to look at.

import { describe, expect, test } from 'bun:test';
import type { DrillFleet } from './drill-fleet';
import { runDrill } from './drill-run';
import { drillNamed } from './drills';

const budgets = {
  deadlineMs: 5,
  promptMs: 1,
  recoveryMs: 1,
  readinessMs: 5,
  drainMs: 1,
  readiness: 'dependencies' as const,
  phaseMs: 1,
};

const emptyFleet: DrillFleet = {
  base: 'http://127.0.0.1:1',
  databaseUrl: 'postgres://unused',
  proxies: new Map(),
  roles: new Map(),
  stop: async () => undefined,
};

describe('runDrill with the wall clock', () => {
  test('a fleet without the faulted service plays nothing, and the verdict is red', async () => {
    const asked: string[] = [];
    const report = await runDrill({
      drill: drillNamed('redis-down') ?? expect.unreachable('redis-down is a drill'),
      fleet: emptyFleet,
      budgets,
      targets: [],
      // No `now()` answer that is a Date: the jobs evidence is absent, not zero.
      sql: {
        rows: async (text) => {
          asked.push(text);
          return [{ t: 'not-a-date' }];
        },
      },
      baselineMs: 1,
    });
    expect(asked).toEqual(['select now() as t']);
    expect(report.name).toBe('redis-down');
    expect(report.evidence.readyz).toBeUndefined();
    expect(report.evidence.jobs).toBeUndefined();
    expect(report.evidence.recoveryMs).toBeUndefined();
    expect(report.evidence.exit).toBeUndefined();
    expect(report.baseline).toEqual({ ok: 0, failed: 0 });
    expect(report.verdict.ok).toBe(false);
    expect(report.verdict.failures.length).toBeGreaterThan(0);
  });
});
