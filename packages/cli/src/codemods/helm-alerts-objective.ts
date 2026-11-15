// 31.18.0: the chart's alerts gain burn-rate rules against `alerts.objective`, and each role's
// memory request is what it measured idle. The rules template, still exactly the old one, is
// replaced whole; each values.yaml line moves where it stands as `x new` wrote it.

import { CHART_FILE, VALUES_FILE } from '../generate-chart-alerts';
import { names } from '../templates/naming';
import { helmMonitoringFiles } from '../templates/scaffold-helm-alerts';
import { chartName } from './chart-dashboard';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';
import { ALERT_RULES_31_15_LINES } from './helm-alerts-stock';

const RULES = 'docker/helm/templates/alert-rules.yaml';

const lines = (...text: readonly string[]): string => text.join('\n');

export const HELM_VALUES_EDITS: readonly SnippetEdit[] = [
  {
    from: lines('alerts:', '  enabled: auto', '  runbookBase:'),
    to: lines(
      'alerts:',
      '  enabled: auto',
      "  objective: 99.9    # percent of requests answered without a 5xx; the burn-rate rules' budget",
      '  runbookBase:',
    ),
  },
  {
    from: lines('    port: 3000', '    resources:', '      requests: { cpu: 200m, memory: 256Mi }'),
    to: lines(
      '    port: 3000',
      '    # Requests are measured idle plus headroom, limits the ceiling: a web pod of the demo app idled',
      '    # at 73 Mi (plan 101 O6, 2026-11-11), so 128Mi; the limit is what an OOMKill reads.',
      '    resources:',
      '      requests: { cpu: 200m, memory: 128Mi }',
    ),
    optional: true,
  },
  {
    from: lines(
      '    retireSeconds: 3600',
      '    resources:',
      '      requests: { cpu: 200m, memory: 256Mi }',
    ),
    to: lines(
      '    retireSeconds: 3600',
      '    # 160Mi: ROLE=worker of the reference app idled at 138 MiB (Bun 1.4.4, 45 s, 2026-11-13).',
      '    resources:',
      '      requests: { cpu: 200m, memory: 160Mi }',
    ),
    optional: true,
  },
  {
    from: lines('    resources:', '      requests: { cpu: 50m, memory: 128Mi }'),
    to: lines(
      '    resources:',
      '      # 160Mi: ROLE=scheduler of the reference app idled at 137 MiB (Bun 1.4.4, 45 s, 2026-11-13).',
      '      requests: { cpu: 50m, memory: 160Mi }',
    ),
    optional: true,
  },
];

/** Today's rules template, when the app's is still the pre-31.18 one exactly. */
async function rules(app: CodemodApp, chart: string): Promise<CodemodResult> {
  const held = await app.read(RULES);
  const stock = ALERT_RULES_31_15_LINES.map((line) => line.replaceAll('<APP>', chart)).join('\n');
  if (held !== stock) return { changed: [], skipped: [] };
  const today = helmMonitoringFiles(names(chart)).find((file) => file.path === RULES)?.contents;
  if (typeof today !== 'string') return { changed: [], skipped: [] };
  await app.write(RULES, today);
  return { changed: [RULES], skipped: [] };
}

export const codemod: Codemod = {
  id: 'helm-alerts-objective',
  since: '31.18.0',
  summary: `${RULES} gains the burn-rate rules, ${VALUES_FILE} alerts.objective and the measured memory requests`,
  async run(app) {
    const chart = chartName((await app.read(CHART_FILE)) ?? '');
    if (chart === undefined) return { changed: [], skipped: [] };
    return mergeResults([
      await rules(app, chart),
      await editSnippets(app, VALUES_FILE, HELM_VALUES_EDITS),
    ]);
  },
};
