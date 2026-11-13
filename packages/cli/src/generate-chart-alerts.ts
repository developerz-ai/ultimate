// `x g chart-alerts` / `x g chart-dashboard`: the chart's monitoring templates (or its Grafana
// dashboard) written into an app whose chart predates them, plus the `values.yaml` blocks it lacks
// — appended, never rewritten, so a deliberate `enabled: false` stays. `--print` is the same table
// for a loader outside Kubernetes. No `<name>`: an app has one chart, and `Chart.yaml` names it.

import { stringField, UltimateError } from '@ultimat3/core';
import { generateSpec } from './cmd-generate-spec';
import type { CommandContext } from './command';
import { invocationOf } from './command';
import { BadFlagError } from './errors';
import { generate } from './generate-files';
import type { Generator } from './generate-kinds';
import { containedPath, planWrites, writeFiles } from './generate-write';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool } from './parse';
import type { GeneratedFile } from './templates';
import { dashboardJson } from './templates/chart-dashboard';
import { ALERTS_VALUES, DASHBOARD_VALUES, SERVICE_MONITOR_VALUES } from './templates/scaffold-helm';
import { CHART_ALERTS } from './templates/scaffold-helm-alert-rules';
import { alertRuleGroups } from './templates/scaffold-helm-alerts';

export const CHART_FILE = 'docker/helm/Chart.yaml';
export const VALUES_FILE = 'docker/helm/values.yaml';

/** The two generators that write into the app's one chart, and only into it. */
export type ChartGenerator = 'chart-alerts' | 'chart-dashboard';

/** A chart is not there to write into. Its fix is the half that needs none. */
export class ChartMissingError extends UltimateError {
  constructor(reason: string, kind: ChartGenerator = 'chart-alerts') {
    super({
      code: 'X_CHART_MISSING',
      cause: `${CHART_FILE} ${reason}, so there is no chart for the ${kind === 'chart-alerts' ? 'monitoring templates' : 'dashboard'} to join`,
      fix:
        kind === 'chart-alerts'
          ? 'x g chart-alerts --print --json'
          : 'x g chart-dashboard --print --json',
    });
  }
}

export const isChartGenerator = (kind: Generator): kind is ChartGenerator =>
  kind === 'chart-alerts' || kind === 'chart-dashboard';

/** `--print` is the chart generators', and on any other one it would be a flag accepted and ignored. */
export function refuseChartAlertsFlags(kind: Generator, args: ParsedArgs): void {
  if (isChartGenerator(kind) || !args.flags.has('print')) return;
  throw new BadFlagError({
    flag: 'print',
    command: `g ${kind}`,
    reason: "--print is the chart-alerts generator's",
    fix: 'x g chart-alerts --print',
  });
}

/** The flags this generator reads; any other set to something but its default is refused. */
const READS = new Set(['print', 'force', 'dry-run']);

/** Each generator's own bare run: a literal per kind, so a fix line splices no value. */
const BARE_RUN: ReadonlyMap<ChartGenerator, string> = new Map([
  ['chart-alerts', 'x g chart-alerts'],
  ['chart-dashboard', 'x g chart-dashboard'],
]);

function refuseUnreadFlags(args: ParsedArgs, kind: ChartGenerator): void {
  const fix = BARE_RUN.get(kind) ?? 'x g chart-alerts';
  const named = args.positionals[1];
  if (named !== undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: `g ${kind}`,
      reason: `takes no <name> and got "${named}": an app has one chart, and Chart.yaml names it`,
      fix,
    });
  }
  for (const flag of generateSpec.flags ?? []) {
    if (READS.has(flag.name)) continue;
    const value = args.flags.get(flag.name);
    if (value === undefined || value === flag.default) continue;
    throw new BadFlagError({
      flag: flag.name,
      command: `g ${kind}`,
      reason: `the ${kind} generator does not read --${flag.name}, so it would change nothing`,
      fix,
    });
  }
}

/** The chart's `name`, which its helpers (`<name>.fullname`, `<name>.labels`) are named after. */
export async function chartName(
  root: string,
  kind: ChartGenerator = 'chart-alerts',
): Promise<string> {
  const file = Bun.file(containedPath(root, CHART_FILE));
  if (!(await file.exists())) throw new ChartMissingError('does not exist', kind);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await file.text());
  } catch {
    throw new ChartMissingError('does not parse as YAML', kind);
  }
  const name = stringField(parsed, 'name');
  if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new ChartMissingError(
      'declares no chart name of lowercase letters, digits and hyphens',
      kind,
    );
  }
  return name;
}

/** Each generator's `values.yaml` blocks, by the top-level key each declares. */
const VALUE_BLOCKS: ReadonlyMap<ChartGenerator, readonly (readonly [string, string])[]> = new Map([
  [
    'chart-alerts',
    [
      ['serviceMonitor', SERVICE_MONITOR_VALUES],
      ['alerts', ALERTS_VALUES],
    ],
  ],
  ['chart-dashboard', [['dashboard', DASHBOARD_VALUES]]],
]);

/**
 * The blocks `values.yaml` lacks, by top-level key. A key already there is the app's — whatever it
 * says — and the templates read a missing one as their default, so a values file this never
 * touches works.
 */
export function missingValueBlocks(values: string, kind: ChartGenerator = 'chart-alerts'): string {
  const has = (key: string) => new RegExp(`^${key}\\s*:`, 'm').test(values);
  return (VALUE_BLOCKS.get(kind) ?? [])
    .filter(([key]) => !has(key))
    .map(([, block]) => block)
    .join('');
}

/** `--print`: what a loader outside Kubernetes takes — rule groups, or the dashboard's JSON. */
function printed(kind: ChartGenerator): CommandResult {
  if (kind === 'chart-dashboard') {
    const json = dashboardJson();
    return {
      ok: true,
      command: 'g',
      summary: msg('cli.generate.chartDashboardPrinted'),
      data: { dashboard: JSON.parse(json) as JsonValue },
      lines: json.trimEnd().split('\n'),
    };
  }
  const rules = alertRuleGroups();
  return {
    ok: true,
    command: 'g',
    summary: msg('cli.generate.chartAlertsPrinted', { count: CHART_ALERTS.length }),
    data: { rules },
    lines: rules.trimEnd().split('\n'),
  };
}

/** `values` with `blocks` appended after one blank line. */
const appended = (values: string, blocks: string): string =>
  `${values.trimEnd()}\n\n${blocks.trimEnd()}\n`;

export async function runChartAlerts(
  ctx: CommandContext,
  root: string,
  kind: ChartGenerator = 'chart-alerts',
): Promise<CommandResult> {
  refuseUnreadFlags(ctx.args, kind);
  if (flagBool(ctx.args, 'print')) return printed(kind);
  const name = await chartName(root, kind);
  const force = flagBool(ctx.args, 'force');
  // Without --force a template already there is kept, never a conflict: it is the app's, and this
  // run's job is the files the chart lacks. --force rewrites them from the current table.
  const files = generate({ kind, name }).map(
    (file): GeneratedFile =>
      force || typeof file.contents !== 'string'
        ? file
        : { path: file.path, contents: file.contents, merge: 'if-absent' },
  );
  const valuesPath = containedPath(root, VALUES_FILE);
  const valuesFile = Bun.file(valuesPath);
  const values = (await valuesFile.exists()) ? await valuesFile.text() : undefined;
  const blocks = values === undefined ? '' : missingValueBlocks(values, kind);
  const edited = blocks === '' ? [] : [VALUES_FILE];
  const invocation = `${invocationOf(ctx, 'g')} ${kind}`;
  const dryRun = flagBool(ctx.args, 'dry-run');
  const report = dryRun
    ? await planWrites(root, files, force, invocation)
    : await writeFiles(root, files, force, invocation);
  if (!dryRun && values !== undefined && blocks !== '') {
    await Bun.write(valuesPath, appended(values, blocks));
  }
  const touched = [...report.written, ...edited];
  // Zero files is a run like any other: a chart that holds both templates and both values blocks.
  const summary = msg(dryRun ? 'cli.generate.planned' : 'cli.generate.wrote', {
    count: touched.length,
    kind,
    name,
  });
  return {
    ok: report.conflicts.length === 0,
    command: 'g',
    summary,
    data: { files: touched, edits: edited, ...(dryRun ? { dryRun: true } : {}) },
    lines: touched.map((path) => msg('cli.file.added', { path })),
    findings: report.conflicts,
  };
}
