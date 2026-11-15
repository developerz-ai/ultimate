// 31.18.0: every chart ships a Grafana dashboard (`dashboards/ultimate-app.json`, its ConfigMap,
// off by default) and a `dashboard:` values block. A chart that predates it gains all three, as
// `x g chart-dashboard` writes them; a file or key the app already holds is the app's.

import { stringField } from '@ultimat3/core';
import { CHART_FILE, missingValueBlocks, VALUES_FILE } from '../generate-chart-alerts';
import { helmDashboardFiles } from '../templates/chart-dashboard';
import { names } from '../templates/naming';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { mergeResults, writeIfAbsent } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** The chart's `name`, which its helpers are named after; undefined when it declares none. */
const chartName = (source: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch {
    return undefined;
  }
  const name = stringField(parsed, 'name');
  return name !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined;
};

async function valuesBlock(app: CodemodApp): Promise<CodemodResult> {
  const values = await app.read(VALUES_FILE);
  if (values === undefined) return NOTHING;
  const blocks = missingValueBlocks(values, 'chart-dashboard');
  if (blocks === '') return NOTHING;
  await app.write(VALUES_FILE, `${values.trimEnd()}\n\n${blocks.trimEnd()}\n`);
  return { changed: [VALUES_FILE], skipped: [] };
}

export const codemod: Codemod = {
  id: 'chart-dashboard',
  since: '31.18.0',
  summary:
    'docker/helm gains the Grafana dashboard: dashboards/ultimate-app.json, templates/dashboard-configmap.yaml and a dashboard: block in values.yaml (off by default)',
  async run(app) {
    const chart = await app.read(CHART_FILE);
    if (chart === undefined) return NOTHING;
    const name = chartName(chart);
    if (name === undefined) {
      return {
        changed: [],
        skipped: [
          {
            path: CHART_FILE,
            reason:
              'it declares no chart name of lowercase letters, digits and hyphens, and the dashboard ConfigMap is named after it: set name:, then run x g chart-dashboard',
          },
        ],
      };
    }
    const written: CodemodResult[] = [];
    for (const file of helmDashboardFiles(names(name))) {
      if (typeof file.contents === 'string') {
        written.push(await writeIfAbsent(app, file.path, file.contents));
      }
    }
    return mergeResults([...written, await valuesBlock(app)]);
  },
};
