// `x doctor`'s chart listing: the monitoring templates and the dashboard an app's Helm chart
// predates, each with the one command that writes it. A LISTING, never a finding: the chart is the app's, and a chart that
// declines the operator's objects (or keeps its own) is a decision `x doctor` must not overrule.

// why: a synchronous exists check; Bun.file().exists() is async and the probe is not.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; existsSync takes one already joined.
import { join } from 'node:path';
import { CHART_FILE } from './generate-chart-alerts';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { GeneratedFile, NameSet } from './templates';
import { names } from './templates';
import { helmDashboardFiles } from './templates/chart-dashboard';
import { helmMonitoringFiles } from './templates/scaffold-helm-alerts';

/** The command every row names: it writes only the files the chart lacks. */
export const CHART_ALERTS_ADD = 'x g chart-alerts';
export const CHART_DASHBOARD_ADD = 'x g chart-dashboard';

const absentOf =
  (files: (app: NameSet) => readonly GeneratedFile[]) =>
  (hasChart: boolean, exists: (path: string) => boolean): readonly string[] =>
    // The paths only — they do not depend on the chart's name.
    hasChart
      ? files(names('app'))
          .map((file) => file.path)
          .filter((path) => !exists(path))
      : [];

/** The dashboard's half of the rule: its JSON and its ConfigMap, absent from a chart that exists. */
export const missingDashboardTemplates = absentOf(helmDashboardFiles);

/** The rule, pure: which monitoring templates are absent from a chart that exists. */
export const missingMonitoringTemplates = absentOf(helmMonitoringFiles);

/** What a chart lacks, per command. An app with no chart lacks nothing. */
export const NOTHING_MISSING: ChartListing = { alerts: [], dashboard: [] };

export interface ChartListing {
  readonly alerts: readonly string[];
  readonly dashboard: readonly string[];
}

/** The I/O half. An app with no chart deploys some other way, and is listed nothing. */
export function chartAlertsProbe(root: string): ChartListing {
  const hasChart = existsSync(join(root, CHART_FILE));
  const exists = (path: string) => existsSync(join(root, path));
  return {
    alerts: missingMonitoringTemplates(hasChart, exists),
    dashboard: missingDashboardTemplates(hasChart, exists),
  };
}

/** The listing, on a result `x doctor` already decided: `ok` and the findings stay as they came. */
export function withChartAlertsListing(
  result: CommandResult,
  { alerts, dashboard }: ChartListing,
): CommandResult {
  if (alerts.length === 0 && dashboard.length === 0) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const rows = (missing: readonly string[], key: string, add: string): readonly string[] =>
    missing.length === 0
      ? []
      : [msg(key, { count: missing.length }), ...missing.map((path) => `  ${path}`), `  ${add}`];
  return {
    ...result,
    data: {
      ...(data as Record<string, JsonValue>),
      ...(alerts.length === 0
        ? {}
        : { chartAlerts: { missing: [...alerts], add: CHART_ALERTS_ADD } }),
      ...(dashboard.length === 0
        ? {}
        : { chartDashboard: { missing: [...dashboard], add: CHART_DASHBOARD_ADD } }),
    },
    lines: [
      ...(result.lines ?? []),
      ...rows(alerts, 'cli.doctor.chartAlerts', CHART_ALERTS_ADD),
      ...rows(dashboard, 'cli.doctor.chartDashboard', CHART_DASHBOARD_ADD),
    ],
  };
}
