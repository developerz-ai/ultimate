// The 31.29.0 helm-alerts-deploy codemod: a chart's rules and dashboard still as 31.18.0–31.28.x
// wrote them become today's, for whatever the chart is named; an edited one is reported with its
// diff and left whole; a second run changes nothing.

import { describe, expect, test } from 'bun:test';
import { DASHBOARD_FILE, DASHBOARD_PANELS, dashboardJson } from '../templates/chart-dashboard';
import { names } from '../templates/naming';
import { DEPLOY_ALERTS } from '../templates/scaffold-helm-alert-deploy';
import { helmMonitoringFiles } from '../templates/scaffold-helm-alerts';
import { memoryCodemodApp } from './codemod';
import {
  codemod,
  DASHBOARD_31_18_SHA256,
  RULES_31_18_SHA256,
  RULES_FILE,
  unnamed,
} from './helm-alerts-deploy';

const CHART = 'docker/helm/Chart.yaml';
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const todayRules = (chart: string): string =>
  String(helmMonitoringFiles(names(chart)).find((file) => file.path === RULES_FILE)?.contents);

/** Today's rules without this release's: what 31.18.0–31.28.x wrote, pinned by the hash below. */
const oldRules = (chart: string): string => {
  let text = todayRules(chart);
  for (const rule of DEPLOY_ALERTS) {
    const start = text.indexOf(`        {{- $r := index $rules "${rule.alert}"`);
    const end = text.indexOf('        {{- end }}\n', start) + '        {{- end }}\n'.length;
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
};

/** The 13 panels 31.18.0 shipped, before this release's. */
const oldDashboard = (): string => dashboardJson(DASHBOARD_PANELS.slice(0, 13));

describe('unit · codemod helm-alerts-deploy', () => {
  test('carries 31.29.0, and the fixtures are the bytes 31.18.0 wrote', () => {
    expect(codemod.since).toBe('31.29.0');
    expect(sha256(unnamed(oldRules('shop'), 'shop'))).toBe(RULES_31_18_SHA256);
    expect(sha256(oldDashboard())).toBe(DASHBOARD_31_18_SHA256);
  });

  test('stock rules and dashboard become today`s, for the chart Chart.yaml names', async () => {
    const app = memoryCodemodApp({
      [CHART]: 'apiVersion: v2\nname: shop\n',
      [RULES_FILE]: oldRules('shop'),
      [DASHBOARD_FILE]: oldDashboard(),
    });
    expect(await codemod.run(app)).toEqual({ changed: [RULES_FILE, DASHBOARD_FILE], skipped: [] });
    expect(app.files[RULES_FILE]).toBe(todayRules('shop'));
    expect(app.files[DASHBOARD_FILE]).toBe(dashboardJson());
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a CRLF checkout is recognised and keeps its line endings', async () => {
    const crlf = (text: string) => text.replaceAll('\n', '\r\n');
    const app = memoryCodemodApp({
      [CHART]: 'apiVersion: v2\nname: shop\n',
      [RULES_FILE]: crlf(oldRules('shop')),
    });
    expect((await codemod.run(app)).changed).toEqual([RULES_FILE]);
    expect(app.files[RULES_FILE]).toBe(crlf(todayRules('shop')));
  });

  test('an edited file is the app`s: left whole, reported with the diff', async () => {
    const edited = oldRules('shop').replace('default "5m"', 'default "7m"');
    const app = memoryCodemodApp({
      [CHART]: 'apiVersion: v2\nname: shop\n',
      [RULES_FILE]: edited,
    });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual([RULES_FILE]);
    expect(result.skipped[0]?.diff).toContain('+        - alert: UltimateRequestLatency');
    expect(app.files[RULES_FILE]).toBe(edited);
  });

  test('no chart, or no such file, is nothing to do', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
    const app = memoryCodemodApp({ [CHART]: 'apiVersion: v2\nname: shop\n' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });
});
