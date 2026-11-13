// The rule table's own claims: multi-window burn rate over the error budget, the objective a chart
// value, and the saturation rules an adopter otherwise writes by hand. `scripts/chart-alerts.test.ts`
// holds the series against the packages; this holds what each rule says.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { CHART_ALERTS, DEFAULT_OBJECTIVE } from './scaffold-helm-alert-rules';
import { alertRuleGroups, helmMonitoringFiles, K8S_SCOPE } from './scaffold-helm-alerts';

const byName = (alert: string) => {
  const found = CHART_ALERTS.find((one) => one.alert === alert);
  if (found === undefined) return expect.unreachable(`no rule ${alert} in CHART_ALERTS`);
  return found;
};

const template = (): string =>
  String(
    helmMonitoringFiles(names('ultimate')).find((file) => file.path.endsWith('alert-rules.yaml'))
      ?.contents ?? '',
  );

describe('unit · burn-rate alerting', () => {
  test('the fast burn pairs a 1h window with a 5m one, the slow a 6h with a 30m', () => {
    const fast = byName('UltimateErrorBudgetFastBurn').expr(K8S_SCOPE);
    const slow = byName('UltimateErrorBudgetSlowBurn').expr(K8S_SCOPE);
    expect([fast.includes('[1h]'), fast.includes('[5m]'), fast.includes(' and ')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([slow.includes('[6h]'), slow.includes('[30m]'), slow.includes(' and ')]).toEqual([
      true,
      true,
      true,
    ]);
    // The workbook's factors: 2 % of a 30-day budget in an hour, 5 % in six.
    expect([
      byName('UltimateErrorBudgetFastBurn').threshold,
      byName('UltimateErrorBudgetSlowBurn').threshold,
    ]).toEqual([14.4, 6]);
  });

  test('the objective is a chart value, read once and range-checked', () => {
    const chart = template();
    expect(chart).toContain('hasKey $cfg "objective"');
    expect(chart).toContain(`${String(DEFAULT_OBJECTIVE)}`);
    expect(chart).toContain('alerts.objective');
    expect(byName('UltimateErrorBudgetFastBurn').expr(K8S_SCOPE)).toContain('{{ $objective }}');
  });

  test('the plain groups spell the objective they were given', () => {
    const groups = alertRuleGroups('job="app"', 99.5);
    expect(groups).toContain('(1 - 99.5 / 100)');
    expect(alertRuleGroups('job="app"')).toContain(`(1 - ${String(DEFAULT_OBJECTIVE)} / 100)`);
    expect(groups).not.toContain('{{');
  });
});

describe('unit · the saturation rules ship as defaults', () => {
  test.each([
    ['UltimateJobFailures', 'jobs_total'],
    ['UltimatePoolSaturated', 'db_pool_waiting'],
    ['UltimateEventLoopLag', 'process_event_loop_lag_seconds_bucket'],
    ['UltimateMemoryNearLimit', 'process_memory_limit_bytes'],
  ])('%s reads %s', (alert, series) => {
    expect(byName(alert).expr(K8S_SCOPE)).toContain(`${series}{`);
  });

  test('memory is RSS over the cgroup limit, per target: one pod near its limit fires', () => {
    const expr = byName('UltimateMemoryNearLimit').expr(K8S_SCOPE);
    expect(expr).toMatch(/process_resident_memory_bytes\{.*\} \/ process_memory_limit_bytes\{/);
    expect(expr).toContain(K8S_SCOPE.target);
  });
});
