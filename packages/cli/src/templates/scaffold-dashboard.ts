// The generated dashboard — `apps/web/app/dashboard/` — moved out of `scaffold-app.ts` because it
// stopped being an `<h1>` in a panel. Two shapes, one per `x new` invocation, and both show only
// what is true of the app that was just written:
//
//   --example     the seeded `post` slice: a stat row, a bar chart of posts per day, the latest
//                 posts in a table. Real rows from the app's own repo, aggregated by a pure view
//                 module this file also emits.
//   --no-example  no entity, so no rows to count and nothing honest to chart. Framework facts
//                 instead — routes, locales, roles, version — and the route table. A chart of
//                 invented numbers would teach the wrong thing to every app that starts here.
//
// One island on the page, the theme toggle (`scaffold-shell.ts`); the tiles, chart and table are
// server markup, which is what keeps the route inside its 60kb budget.

import type { GeneratedFile, NameSet } from './naming';
import { bareDashboardFiles } from './scaffold-dashboard-bare';
import { exampleDashboardFiles } from './scaffold-dashboard-example';
import { DASHBOARD_DIR, dashboardPageTest, dashboardStyle } from './scaffold-dashboard-shared';

/** `apps/web/app/dashboard/`, in the shape the invocation earns. */
export function dashboardFiles(app: NameSet, example: boolean): readonly GeneratedFile[] {
  return [
    ...(example ? exampleDashboardFiles(app) : bareDashboardFiles(app)),
    { path: `${DASHBOARD_DIR}/page.module.scss`, contents: dashboardStyle() },
    { path: `${DASHBOARD_DIR}/page.test.ts`, contents: dashboardPageTest() },
  ];
}
