// `x g chart-dashboard`: the chart's Grafana dashboard written into an app whose chart predates it,
// the `dashboard:` values block appended, and `--print` the JSON a Grafana outside Kubernetes
// imports. `x doctor` lists the dashboard as missing, with this command.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, so a throwaway app root's lifetime is node:fs's.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { missingDashboardTemplates } from './doctor-chart-alerts';
import { exec } from './exec';
import { missingValueBlocks } from './generate-chart-alerts';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { names } from './templates';
import { dashboardJson, helmDashboardFiles } from './templates/chart-dashboard';
import { helmFiles } from './templates/scaffold-helm';

const JSON_FILE = 'docker/helm/dashboards/ultimate-app.json';
const CONFIG_MAP = 'docker/helm/templates/dashboard-configmap.yaml';
const VALUES = 'docker/helm/values.yaml';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function appRoot(chart: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-chart-dashboard-'));
  roots.push(root);
  await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
  if (chart) {
    await Bun.write(join(root, 'docker/helm/Chart.yaml'), 'apiVersion: v2\nname: shop\n');
    await Bun.write(join(root, VALUES), 'replicaCount: 1\n');
  }
  return root;
}

const run = (root: string, ...argv: string[]) =>
  generateCommand.run({
    args: parseArgs(['g', 'chart-dashboard', ...argv], SPECS),
    cwd: root,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  } satisfies CommandContext);

const read = (root: string, path: string) => Bun.file(join(root, path)).text();

describe('unit · x g chart-dashboard', () => {
  test('writes the JSON and its ConfigMap for the chart Chart.yaml names, and the values block', async () => {
    const root = await appRoot(true);
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ files: [JSON_FILE, CONFIG_MAP, VALUES], edits: [VALUES] });
    const expected = new Map(helmDashboardFiles(names('shop')).map((f) => [f.path, f.contents]));
    expect(await read(root, JSON_FILE)).toBe(expected.get(JSON_FILE) as string);
    expect(await read(root, CONFIG_MAP)).toContain('include "shop.fullname"');
    const values: unknown = Bun.YAML.parse(await read(root, VALUES));
    expect(values).toMatchObject({ replicaCount: 1, dashboard: { enabled: false } });
    // The alerts' blocks are the other generator's: this one appends its own only.
    expect(values).not.toHaveProperty('alerts');
  });

  test('a second run writes nothing', async () => {
    const root = await appRoot(true);
    await run(root);
    const again = await run(root);
    expect(again.data).toMatchObject({ files: [], edits: [] });
  });

  test('--print is the dashboard JSON, and needs no chart', async () => {
    const root = await appRoot(false);
    const result = await run(root, '--print');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ dashboard: JSON.parse(dashboardJson()) });
  });

  test('no chart is X_CHART_MISSING', async () => {
    const root = await appRoot(false);
    const failure = (await run(root).catch((error: unknown) => error)) as Record<string, unknown>;
    expect(failure['code']).toBe('X_CHART_MISSING');
  });

  test('the values block is the scaffold’s own bytes', () => {
    const scaffold = helmFiles(names('shop')).find((file) => file.path === VALUES);
    const block = missingValueBlocks('replicaCount: 1\n', 'chart-dashboard');
    expect(block).toContain('dashboard:');
    expect(scaffold?.contents).toContain(block);
    expect(missingValueBlocks(scaffold?.contents as string, 'chart-dashboard')).toBe('');
  });
});

describe('unit · x doctor lists a chart with no dashboard', () => {
  test('both files, only when a chart exists', () => {
    expect(missingDashboardTemplates(true, () => false)).toEqual([JSON_FILE, CONFIG_MAP]);
    expect(missingDashboardTemplates(true, () => true)).toEqual([]);
    expect(missingDashboardTemplates(false, () => false)).toEqual([]);
  });
});
