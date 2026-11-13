// The chart's dashboard: one column a phone reads unchanged, every query scoped to the release the
// variables pick, opt-in behind dashboard.enabled, and the framework chart's copies are the
// generator's bytes. `scripts/chart-dashboard.test.ts` holds each series against the packages.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  DASHBOARD_PANELS,
  DASHBOARD_UID,
  dashboardJson,
  helmDashboardFiles,
} from './chart-dashboard';
import { names } from './naming';
import { helmFiles } from './scaffold-helm';
import { helmTemplateFiles } from './scaffold-helm-templates';

const CHART = join(import.meta.dir, '..', '..', '..', '..', 'docker', 'helm');

interface Panel {
  readonly id: number;
  readonly gridPos: { readonly x: number; readonly w: number };
  readonly targets: readonly { readonly expr: string }[];
}

const model = (): { uid: string; timezone: string; panels: readonly Panel[] } =>
  JSON.parse(dashboardJson());

describe('unit · the chart dashboard', () => {
  test('a stable uid and an explicit timezone', () => {
    expect(model().uid).toBe(DASHBOARD_UID);
    expect(model().timezone).toBe('utc');
  });

  test('one full-width column: every panel at x 0, 24 wide, ids unique', () => {
    const panels = model().panels;
    expect(panels.length).toBe(DASHBOARD_PANELS.length);
    expect(panels.every((panel) => panel.gridPos.x === 0 && panel.gridPos.w === 24)).toBe(true);
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(panels.length);
  });

  test('every query reads only the release the variables pick', () => {
    for (const panel of model().panels) {
      for (const target of panel.targets) {
        const selectors = [...target.expr.matchAll(/[a-z_]+\{([^}]*)\}/g)].map((m) => m[1]);
        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
          expect(selector).toContain(
            'namespace="$namespace",app_kubernetes_io_instance="$release"',
          );
        }
      }
    }
  });

  test('the panels cover requests, latency, statements, pool, jobs, realtime and the process', () => {
    const exprs = DASHBOARD_PANELS.flatMap((panel) => panel.targets.map((t) => t.expr)).join('\n');
    for (const series of [
      'http_requests_total',
      'http_request_duration_seconds_bucket',
      'db_client_operation_duration_seconds_bucket',
      'db_pool_waiting',
      'jobs_total',
      'queue_oldest_ready_seconds',
      'connections',
      'process_memory_limit_bytes',
      'process_event_loop_lag_seconds_bucket',
    ]) {
      expect(exprs).toContain(`${series}{`);
    }
  });

  test('the ConfigMap is opt-in and ships the JSON untemplated', () => {
    const template = String(
      helmDashboardFiles(names('ultimate')).find((file) => file.path.endsWith('.yaml'))?.contents,
    );
    expect(template).toContain('if eq (toString $cfg.enabled) "true"');
    expect(template).toContain('.Files.Get "dashboards/ultimate-app.json"');
  });

  test('the framework chart holds the generator`s bytes', async () => {
    for (const file of helmDashboardFiles(names('ultimate'))) {
      const path = join(CHART, file.path.replace(/^docker\/helm\//, ''));
      const held = await Bun.file(path)
        .text()
        .catch(() => '');
      expect({ [file.path]: held }).toEqual({ [file.path]: String(file.contents) });
    }
  });

  test('a scaffolded chart ships it too, off by default in both charts', async () => {
    const paths = helmTemplateFiles(names('my-app')).map((file) => file.path);
    expect(paths).toContain('docker/helm/dashboards/ultimate-app.json');
    expect(paths).toContain('docker/helm/templates/dashboard-configmap.yaml');
    const scaffold = helmFiles(names('my-app')).find((f) => f.path === 'docker/helm/values.yaml');
    const values = (text: string) => (Bun.YAML.parse(text) as { dashboard?: unknown }).dashboard;
    const chart = values(await Bun.file(join(CHART, 'values.yaml')).text());
    expect(chart).toMatchObject({ enabled: false });
    expect(values(String(scaffold?.contents ?? ''))).toEqual(chart);
  });
});
