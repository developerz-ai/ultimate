// The 31.18.0 chart-dashboard codemod: a chart that predates the Grafana dashboard gains the JSON,
// its ConfigMap (named for the chart Chart.yaml declares) and the `dashboard:` values block — the
// same bytes `x new` writes today. What the app already holds is its own and stays as it is.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { helmDashboardFiles } from '../templates/chart-dashboard';
import { DASHBOARD_VALUES } from '../templates/scaffold-helm';
import { codemod } from './chart-dashboard';
import { memoryCodemodApp } from './codemod';

const JSON_FILE = 'docker/helm/dashboards/ultimate-app.json';
const CONFIG_MAP = 'docker/helm/templates/dashboard-configmap.yaml';
const VALUES = 'docker/helm/values.yaml';
const CHART = 'docker/helm/Chart.yaml';

const expected = new Map(helmDashboardFiles(names('shop')).map((f) => [f.path, f.contents]));

describe('unit · codemod chart-dashboard', () => {
  test('carries 31.18.0', () => {
    expect(codemod.since).toBe('31.18.0');
  });

  test('a chart without the dashboard gains it, for the chart Chart.yaml names', async () => {
    const app = memoryCodemodApp({
      [CHART]: 'apiVersion: v2\nname: shop\n',
      [VALUES]: 'replicaCount: 1\n',
    });
    const result = await codemod.run(app);
    expect(result).toEqual({ changed: [JSON_FILE, CONFIG_MAP, VALUES], skipped: [] });
    expect(app.files[JSON_FILE]).toBe(expected.get(JSON_FILE) as string);
    expect(app.files[CONFIG_MAP]).toBe(expected.get(CONFIG_MAP) as string);
    expect(app.files[VALUES]).toBe(`replicaCount: 1\n\n${DASHBOARD_VALUES.trimEnd()}\n`);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a dashboard the app already holds, and its own dashboard: key, are left as they are', async () => {
    const files = {
      [CHART]: 'apiVersion: v2\nname: shop\n',
      [VALUES]: 'dashboard:\n  enabled: true\n',
      [JSON_FILE]: '{"mine":true}\n',
      [CONFIG_MAP]: '# mine\n',
    };
    const app = memoryCodemodApp({ ...files });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual(files);
  });

  test('no chart is nothing to do; a Chart.yaml naming no chart is reported, not guessed', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
    const app = memoryCodemodApp({ [CHART]: 'apiVersion: v2\n' });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual([CHART]);
    expect(result.skipped[0]?.reason).toContain('x g chart-dashboard');
  });
});
