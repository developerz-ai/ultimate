// The alert rules every chart renders (`packages/cli/src/templates/scaffold-helm-alert-rules.ts`) read
// only series the framework declares, and each one names a runbook entry that exists. A renamed
// metric is a rule that evaluates to "no data" forever and looks correct in review — so a rename
// with no matching rule edit is red here, not silent in a cluster.
//
// When a helm binary is on PATH (CI's ubuntu runners ship one) the framework chart is rendered too:
// with and without the operator's API, and with the switches declined.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  CHART_ALERTS,
  type ChartAlert,
} from '../packages/cli/src/templates/scaffold-helm-alert-rules';
import { alertRuleGroups, K8S_SCOPE } from '../packages/cli/src/templates/scaffold-helm-alerts';
import { declaredSeries, isDeclared } from './lib/declared-series';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const RUNBOOKS = join(ROOT, 'docs', 'ops', '06-runbooks.md');
const HELM = Bun.which('helm');

/** The PromQL words an expression may hold besides series: aggregators, functions, operators. */
const PROMQL_WORDS = new Set([
  'max',
  'sum',
  'count',
  'rate',
  'histogram_quantile',
  'by',
  'and',
  'or',
  'unless',
  'bool',
]);

/** `up` is Prometheus' own, written per target by the scraper rather than declared by a package. */
const SCRAPER_SERIES = new Set(['up']);

/** The identifiers an expression reads as series: matchers, ranges and `by (…)` lists dropped. */
function seriesOf(expr: string): readonly string[] {
  const bare = expr
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bby\s*\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ');
  const words = bare.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? [];
  return [...new Set(words.filter((word) => !PROMQL_WORDS.has(word)))];
}

/** Each rule's series that no package declares, as `<alert>: <series>`. */
function unknownSeries(alerts: readonly ChartAlert[], declared: ReadonlySet<string>): string[] {
  return alerts.flatMap((alert) =>
    seriesOf(alert.expr(K8S_SCOPE))
      .filter((series) => !isDeclared(series, declared) && !SCRAPER_SERIES.has(series))
      .map((series) => `${alert.alert}: ${series}`),
  );
}

/** GitHub's heading anchor: lower-cased, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');

describe('unit · the chart alert rules read declared series', () => {
  test('every series a rule reads is declared by a package, or is the scraper`s own `up`', async () => {
    const declared = await declaredSeries(ROOT);
    // fix: rename the rule's series in packages/cli/src/templates/scaffold-helm-alerts.ts to the
    // name the package passes to counter(/gauge(, then copy the regenerated alert-rules.yaml.
    expect(unknownSeries(CHART_ALERTS, declared)).toEqual([]);
  });

  test('a renamed series is caught', async () => {
    const declared = await declaredSeries(ROOT);
    const renamed = CHART_ALERTS.map((alert) =>
      alert.alert === 'UltimateDeadLetters'
        ? { ...alert, expr: () => 'max by (queue) (queue_dead_letters{}) > 0' }
        : alert,
    );
    expect(unknownSeries(renamed, declared)).toEqual(['UltimateDeadLetters: queue_dead_letters']);
  });

  test('every series a rule reads is scoped to the release', () => {
    for (const alert of CHART_ALERTS) {
      const expr = alert.expr(K8S_SCOPE);
      const unscoped = seriesOf(expr).filter((series) =>
        new RegExp(`\\b${series}\\b(?!\\{namespace=)`).test(expr),
      );
      expect({ [alert.alert]: unscoped }).toEqual({ [alert.alert]: [] });
    }
  });

  test('every rule waits, carries a severity, and names a runbook entry that exists', async () => {
    const headings = (await Bun.file(RUNBOOKS).text())
      .split('\n')
      .filter((line) => /^#{2,4} /.test(line))
      .map((line) => anchorOf(line.replace(/^#+ /, '')));
    for (const alert of CHART_ALERTS) {
      expect({ [alert.alert]: /^\d+[smh]$/.test(alert.for) }).toEqual({ [alert.alert]: true });
      expect(['warning', 'critical']).toContain(alert.severity);
      expect(headings).toContain(alert.anchor);
    }
  });

  test('the plain rule groups carry every rule, with its default threshold', () => {
    const groups = alertRuleGroups('job="app"');
    for (const alert of CHART_ALERTS) expect(groups).toContain(`- alert: ${alert.alert}\n`);
    expect(groups).toContain('queue_oldest_ready_seconds{job="app"}) > 300');
    expect(groups).not.toContain('{{');
    expect(Bun.YAML.parse(groups)).toMatchObject({ groups: [{ name: 'ultimate' }] });
  });
});

const kinds = async (...args: readonly string[]): Promise<readonly string[]> => {
  const helm = Bun.spawn(
    [
      HELM ?? 'helm',
      'template',
      'app',
      join(ROOT, 'docker', 'helm'),
      '--set-string',
      'image.repository=x',
      ...args,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(helm.stdout).text(),
    new Response(helm.stderr).text(),
    helm.exited,
  ]);
  expect({ code, err }).toEqual({ code: 0, err: '' });
  return [...out.matchAll(/^kind: (ServiceMonitor|PrometheusRule)$/gm)].map((m) => m[1] ?? '');
};

const OPERATOR = [
  '--api-versions',
  'monitoring.coreos.com/v1/ServiceMonitor',
  '--api-versions',
  'monitoring.coreos.com/v1/PrometheusRule',
];

describe.skipIf(HELM === null)(
  'unit · the framework chart renders its scrape and rules by capability',
  () => {
    test('a cluster without the operator gets neither', async () => {
      expect(await kinds()).toEqual([]);
    });

    test('a cluster with the operator gets both, with no value set', async () => {
      expect(await kinds(...OPERATOR)).toEqual(['PrometheusRule', 'ServiceMonitor']);
    });

    test('a deliberate false is honoured on a cluster with the operator', async () => {
      const off = ['--set', 'serviceMonitor.enabled=false', '--set', 'alerts.enabled=false'];
      expect(await kinds(...OPERATOR, ...off)).toEqual([]);
    });

    test('true forces both without the operator', async () => {
      const on = ['--set', 'serviceMonitor.enabled=true', '--set', 'alerts.enabled=true'];
      expect(await kinds(...on)).toEqual(['PrometheusRule', 'ServiceMonitor']);
    });

    test('a values file with neither block still renders both on a cluster with the operator', async () => {
      const old = ['--set', 'serviceMonitor=null', '--set', 'alerts=null'];
      expect(await kinds(...OPERATOR, ...old)).toEqual(['PrometheusRule', 'ServiceMonitor']);
    });
  },
);
