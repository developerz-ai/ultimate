// `x doctor`'s chart listing: the monitoring templates an app's Helm chart predates, with the one
// command that writes them. A LISTING, never a finding: the chart is the app's, and a chart that
// declines the operator's objects (or keeps its own) is a decision `x doctor` must not overrule.

// why: a synchronous exists check; Bun.file().exists() is async and the probe is not.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; existsSync takes one already joined.
import { join } from 'node:path';
import { CHART_FILE } from './generate-chart-alerts';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { names } from './templates';
import { helmMonitoringFiles } from './templates/scaffold-helm-alerts';

/** The command every row names: it writes only the files the chart lacks. */
export const CHART_ALERTS_ADD = 'x g chart-alerts';

/** The rule, pure: which monitoring templates are absent from a chart that exists. */
export function missingMonitoringTemplates(
  hasChart: boolean,
  exists: (path: string) => boolean,
): readonly string[] {
  if (!hasChart) return [];
  // The paths only — they do not depend on the chart's name.
  return helmMonitoringFiles(names('app'))
    .map((file) => file.path)
    .filter((path) => !exists(path));
}

/** The I/O half. An app with no chart deploys some other way, and is listed nothing. */
export function chartAlertsProbe(root: string): readonly string[] {
  return missingMonitoringTemplates(existsSync(join(root, CHART_FILE)), (path) =>
    existsSync(join(root, path)),
  );
}

/** The listing, on a result `x doctor` already decided: `ok` and the findings stay as they came. */
export function withChartAlertsListing(
  result: CommandResult,
  missing: readonly string[],
): CommandResult {
  if (missing.length === 0) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const chartAlerts: JsonValue = { missing: [...missing], add: CHART_ALERTS_ADD };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), chartAlerts },
    lines: [
      ...(result.lines ?? []),
      msg('cli.doctor.chartAlerts', { count: missing.length }),
      ...missing.map((path) => `  ${path}`),
      `  ${CHART_ALERTS_ADD}`,
    ],
  };
}
