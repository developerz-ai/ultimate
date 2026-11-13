// Every series the chart's dashboard (`packages/cli/src/templates/chart-dashboard.ts`) reads is one
// a package declares: a renamed metric is a panel that says "No data" forever and looks fine in
// review, so a rename with no matching panel edit is red here.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { DASHBOARD_PANELS } from '../packages/cli/src/templates/chart-dashboard';
import { declaredSeries, isDeclared } from './lib/declared-series';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** The series an expression reads: every identifier directly followed by its `{` selector. */
const seriesOf = (expr: string): readonly string[] =>
  [...expr.matchAll(/([a-z_:][a-z0-9_:]*)\{/g)].map((match) => match[1] ?? '');

describe('unit · the chart dashboard reads declared series', () => {
  test('every panel`s series is declared by a package', async () => {
    const declared = await declaredSeries(repoRoot());
    const unknown = DASHBOARD_PANELS.flatMap((panel) =>
      panel.targets.flatMap((target) =>
        seriesOf(target.expr)
          .filter((series) => !isDeclared(series, declared))
          .map((series) => `${panel.title}: ${series}`),
      ),
    );
    // fix: rename the panel's series in packages/cli/src/templates/chart-dashboard.ts to the name
    // the package declares, then regenerate docker/helm/dashboards/ultimate-app.json.
    expect(unknown).toEqual([]);
  });

  test('a renamed series is caught', async () => {
    const declared = await declaredSeries(repoRoot());
    expect(isDeclared('db_pool_queued', declared)).toBe(false);
    expect(isDeclared('db_pool_waiting', declared)).toBe(true);
    expect(isDeclared('job_duration_seconds_bucket', declared)).toBe(true);
  });
});
