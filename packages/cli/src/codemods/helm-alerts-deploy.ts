// 31.29.0: the chart's alerts gain the deploy-contract rules (latency, the Postgres server, the
// framework schema, volumes) and its dashboard their panels. Each file, still exactly as 31.18.0
// through 31.28.x wrote it (recognised by hash), is replaced whole; one the app edited is reported.

import { CHART_FILE } from '../generate-chart-alerts';
import { DASHBOARD_FILE, dashboardJson } from '../templates/chart-dashboard';
import { names } from '../templates/naming';
import { helmMonitoringFiles } from '../templates/scaffold-helm-alerts';
import { chartName } from './chart-dashboard';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import { mergeResults, readText } from './engine-edits';

export const RULES_FILE = 'docker/helm/templates/alert-rules.yaml';

/** SHA-256 of `alert-rules.yaml` as 31.18.0–31.28.x wrote it, its chart name spelled `<APP>`. */
export const RULES_31_18_SHA256 =
  'ae896fa5eea1c56d93f6c498fbf3dc026318be9feabcf0dbcbad2bc850c3d348';

/** SHA-256 of `dashboards/ultimate-app.json` as 31.18.0–31.28.x wrote it (it names no chart). */
export const DASHBOARD_31_18_SHA256 =
  'db34c29579f532cb5dac35de3f3e63141cf64e30643917b74e0eb9ecbd081f38';

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** The chart's name in its helpers, spelled `<APP>`: one hash recognises every app's copy. */
export const unnamed = (text: string, chart: string): string =>
  text.replaceAll(`include "${chart}.`, 'include "<APP>.');

/**
 * Today's bytes over the stock ones; a file already today's, or absent, is left alone. Anything else
 * is the app's, reported with what writing today's would change.
 */
async function replaceStock(
  app: CodemodApp,
  path: string,
  stock: (text: string) => boolean,
  today: string,
  what: string,
): Promise<CodemodResult> {
  const file = await readText(app, path);
  if (file === undefined || file.text === today) return { changed: [], skipped: [] };
  if (stock(file.text)) {
    await app.write(path, file.restore(today));
    return { changed: [path], skipped: [] };
  }
  return {
    changed: [],
    skipped: [
      {
        path,
        reason: `the chart's ${what} is the app's own, so the deploy-contract additions were not written: the diff is today's file against yours, to merge by hand`,
        diff: unifiedDiff(path, file.text, today),
      },
    ],
  };
}

export const codemod: Codemod = {
  id: 'helm-alerts-deploy',
  since: '31.29.0',
  summary: `${RULES_FILE} gains the latency, Postgres, framework-schema and volume rules, and ${DASHBOARD_FILE} their panels`,
  async run(app) {
    const chart = chartName((await readText(app, CHART_FILE))?.text ?? '');
    if (chart === undefined) return { changed: [], skipped: [] };
    const rules = helmMonitoringFiles(names(chart)).find((one) => one.path === RULES_FILE);
    if (typeof rules?.contents !== 'string') return { changed: [], skipped: [] };
    return mergeResults([
      await replaceStock(
        app,
        RULES_FILE,
        (text) => sha256(unnamed(text, chart)) === RULES_31_18_SHA256,
        rules.contents,
        'alert rules',
      ),
      await replaceStock(
        app,
        DASHBOARD_FILE,
        (text) => sha256(text) === DASHBOARD_31_18_SHA256,
        dashboardJson(),
        'dashboard',
      ),
    ]);
  },
};
