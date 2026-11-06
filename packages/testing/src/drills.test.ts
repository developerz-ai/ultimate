// The drill table holds to the verdict's vocabulary, and each drill's thresholds come from the
// app's config: the deadline, the drain, the readiness mode — and `--budget-ms` over the deadline.

import { describe, expect, test } from 'bun:test';
import { DRILL_DEFAULT_DEADLINE_MS, DRILL_PROMPT_MS, drillBudgets } from './drill-budgets';
import { DRILL_PROPERTIES } from './drill-verdict';
import { DRILL_NAMES, DRILLS, drillNamed, drillRoles, drillService } from './drills';
import { screenFaultMode } from './fault-proxy';

const config = {
  requestTimeoutMs: 4_000,
  drainDeadlineMs: 25_000,
  readinessGraceMs: 0,
  readiness: 'dependencies' as const,
};

describe('DRILLS', () => {
  test('the eight drills, once each', () => {
    expect([...DRILL_NAMES].sort()).toEqual([
      'nats-down',
      'pg-blackhole',
      'pg-restart',
      'pg-slow',
      'redis-down',
      'web-sigterm',
      'worker-sigkill',
      'worker-sigterm',
    ]);
  });

  test('every drill states a property the verdict judges, and every phase is a valid mode', () => {
    const budgets = drillBudgets(config);
    for (const drill of DRILLS) {
      expect(drill.holds.length).toBeGreaterThan(0);
      for (const property of drill.holds) expect(DRILL_PROPERTIES).toContain(property);
      if (drill.fault.kind === 'service') {
        for (const mode of drill.fault.phases(budgets)) expect(screenFaultMode(mode)).toBe(mode);
      }
    }
  });

  test('pg-slow delays under the deadline, so the drill measures slow and not dead', () => {
    const drill = drillNamed('pg-slow') ?? expect.unreachable();
    if (drill.fault.kind !== 'service') expect.unreachable();
    const [mode] = drill.fault.phases(drillBudgets(config));
    expect(mode).toEqual({ kind: 'delay', ms: 2_000 });
  });

  test('only a drill that judges a sync client runs the sync role', () => {
    const withSync = DRILLS.filter((drill) => drillRoles(drill).includes('sync'));
    expect(withSync.map((drill) => drill.name)).toEqual(['nats-down']);
    expect(drillRoles(drillNamed('pg-blackhole') ?? expect.unreachable())).toEqual([
      'web',
      'worker',
    ]);
  });

  test('drillService names the faulted service, or nothing for a signal', () => {
    expect(drillService(drillNamed('redis-down') ?? expect.unreachable())).toBe('redis');
    expect(drillService(drillNamed('web-sigterm') ?? expect.unreachable())).toBeUndefined();
    expect(drillNamed('pg-nope')).toBeUndefined();
  });
});

describe('drillBudgets', () => {
  test('derived from the config', () => {
    expect(drillBudgets(config)).toEqual({
      deadlineMs: 4_000,
      promptMs: DRILL_PROMPT_MS,
      recoveryMs: 4_000,
      readinessMs: 4_000,
      drainMs: 25_000,
      readiness: 'dependencies',
      override: undefined,
      phaseMs: 4_000 + DRILL_PROMPT_MS,
    });
  });

  test('--budget-ms replaces the deadline and is kept for the verdict', () => {
    expect(drillBudgets(config, 900)).toMatchObject({ deadlineMs: 900, override: 900 });
  });

  test('"no deadline" is measured against the framework default', () => {
    expect(drillBudgets({ ...config, requestTimeoutMs: 0 }).deadlineMs).toBe(
      DRILL_DEFAULT_DEADLINE_MS,
    );
  });

  test('a budget that is not a whole positive number is refused', () => {
    expect(() => drillBudgets(config, 0)).toThrow(/--budget-ms/);
    expect(() => drillBudgets({ ...config, drainDeadlineMs: Number.NaN })).toThrow(
      /drainDeadlineMs/,
    );
  });
});
