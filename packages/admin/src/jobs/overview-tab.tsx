// The `/_x` jobs tab's body: the SAME `JobsOverview` `/admin/jobs` renders, over this process's
// own queue (the dev driver under `x dev`) — one jobs UI, not a second one in the dev panel. Only
// ever reached by `dev/panel-jobs.ts`'s dynamic `import()`, so `/_x`'s mount graph stays free of it.

import { createContext, runWithContext } from '@ultimat3/core';
import { renderToHtml } from '@ultimat3/render/server';
import { listHref } from '../list-request';
import { adminMounts } from '../mounts';
import { JOB_ENTITY } from './job-entities';
import { JobsOverview } from './overview';
import {
  DEFAULT_RANGE,
  OVERVIEW_RANGES,
  type OverviewRange,
  overviewData,
  RANGE_PARAM,
} from './overview-data';

const isRange = (value: string | null): value is OverviewRange =>
  value !== null && Object.hasOwn(OVERVIEW_RANGES, value);

/**
 * The overview as HTML, its links into the app's own admin when one is mounted — the lists live
 * there — and into this tab's `--json` otherwise. `/_x` is the framework's tool, so it reads in
 * the framework's locale and in UTC, stated rather than ambient.
 */
export async function jobsTabHtml(tabPath: string, params: URLSearchParams): Promise<string> {
  const asked = params.get(RANGE_PARAM);
  const range = isRange(asked) ? asked : DEFAULT_RANGE;
  const admin = adminMounts()[0];
  const runs = admin?.resources.find((resource) => resource.name === JOB_ENTITY.jobs);
  const workers = admin?.resources.find((resource) => resource.name === JOB_ENTITY.workers);
  const json = `${tabPath}?json=1`;
  const data = await overviewData(range, Date.now());
  // The framework catalog's locale for every label, whatever the app's default is.
  return runWithContext(createContext({ locale: 'en', tz: 'UTC' }), () =>
    renderToHtml(
      <JobsOverview
        data={data}
        range={range}
        locale="en"
        timeZone="UTC"
        hrefs={{
          state: (state) =>
            admin === undefined || runs === undefined
              ? json
              : listHref(admin.basePath, runs, { scope: state }),
          name: (name) =>
            admin === undefined || runs === undefined
              ? json
              : listHref(admin.basePath, runs, {
                  filters: [{ field: 'name', op: 'eq', value: name }],
                }),
          workers:
            admin === undefined || workers === undefined ? json : listHref(admin.basePath, workers),
          range: (next) => `${tabPath}?${RANGE_PARAM}=${next}`,
        }}
      />,
    ),
  );
}
