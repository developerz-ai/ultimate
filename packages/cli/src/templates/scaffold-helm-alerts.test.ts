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

describe('unit · the deploy-contract rules (plan 101, 09 D4)', () => {
  test.each([
    ['UltimateRequestLatency', 'http_request_duration_seconds_bucket'],
    ['UltimateConnectionsNearMax', 'db_server_max_connections'],
    ['UltimateLongTransaction', 'db_longest_transaction_seconds'],
    ['UltimateAutovacuumLag', 'db_autovacuum_backlog_ratio'],
    ['UltimateReplicationSlotRetention', 'db_replication_slot_retained_bytes'],
    ['UltimateSchemaUnapplied', 'framework_schema_applied'],
    ['UltimateVersionSkew', 'framework_schema_major_skew'],
  ])('%s reads %s, scoped to the release', (alert, series) => {
    expect(byName(alert).expr(K8S_SCOPE)).toContain(
      `${series}{namespace="{{ $.Release.Namespace }}",app_kubernetes_io_instance=`,
    );
  });

  test('latency is the p95 over the whole release, never per route', () => {
    const expr = byName('UltimateRequestLatency').expr(K8S_SCOPE);
    expect(expr).toStartWith(
      'histogram_quantile(0.95, sum by (namespace, app_kubernetes_io_instance, le)',
    );
    expect(expr).not.toContain('route');
  });

  test('a slot is its own alert; a volume is a claim in the release`s namespace', () => {
    expect(byName('UltimateReplicationSlotRetention').expr(K8S_SCOPE)).toContain(', slot)');
    const volume = byName('UltimateVolumeNearFull').expr(K8S_SCOPE);
    expect(volume).toContain(
      'kubelet_volume_stats_used_bytes{namespace="{{ $.Release.Namespace }}"}',
    );
    expect(volume).toContain('by (namespace, persistentvolumeclaim)');
  });

  test('a schema no migrate applied pages; a skewed fleet only warns', () => {
    expect(byName('UltimateSchemaUnapplied').severity).toBe('critical');
    expect(byName('UltimateVersionSkew').severity).toBe('warning');
  });
});

describe('unit · every rule says how loud it is and where its runbook is', () => {
  /** The rendered template, one block per rule. */
  const blocks = (): readonly string[] => template().split('        - alert: ').slice(1);

  test('one rendered block per rule, each with a severity and a runbook_url', () => {
    expect(blocks().length).toBe(CHART_ALERTS.length);
    for (const block of blocks()) {
      const name = block.slice(0, block.indexOf('\n'));
      expect({
        [name]: /severity: \{\{ \$r\.severity \| default "(warning|critical)" \}\}/.test(block),
      }).toEqual({
        [name]: true,
      });
      expect(block).toContain(`runbook_url: {{ printf "%s#${name.toLowerCase()}" $base | quote }}`);
    }
  });

  test('the plain groups carry both on every rule too', () => {
    const groups = alertRuleGroups('job="app"');
    const count = (needle: string) => groups.split(needle).length - 1;
    expect([count('severity: '), count('runbook_url: ')]).toEqual([
      CHART_ALERTS.length,
      CHART_ALERTS.length,
    ]);
  });

  test('a rule over job runs never pages: a retried job is an expected outcome', () => {
    const overJobs = CHART_ALERTS.filter((rule) => /\bjobs?_\w+\{/.test(rule.expr(K8S_SCOPE)));
    expect(overJobs.map((rule) => rule.alert)).toContain('UltimateJobFailures');
    expect(overJobs.filter((rule) => rule.severity === 'critical').map((r) => r.alert)).toEqual([]);
  });

  test('anchors are unique, so no two rules land on one runbook entry', () => {
    const anchors = CHART_ALERTS.map((rule) => rule.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
