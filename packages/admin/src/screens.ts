// View → screen: the one table that says what renders at each route of the admin. A route whose
// view has no row here does not compile, so a new `AdminView` cannot mount with nothing behind it.

import type { AdminApp, AdminRoute, AdminView } from './admin';
import { AdminPagePathInvalidError } from './errors';
import { jobsOverviewScreen } from './jobs/overview';
import { type AdminScreen, guardedScreen } from './screen-frame';
import { homeScreen } from './screen-home';
import { lookupScreen } from './screen-lookup';
import { createScreen, detailScreen, editScreen, listScreen } from './screen-resource';
import { auditScreen, searchScreen } from './screen-system';

type Build = (app: AdminApp, route: AdminRoute) => AdminScreen;

/** A resource view names its entity; the table and `defineAdmin` are built from the same list. */
const resourceOf = (app: AdminApp, route: AdminRoute) => app.resource(route.entity ?? '');

const SCREENS: Readonly<Record<AdminView, Build>> = {
  dashboard: homeScreen,
  search: searchScreen,
  jobs: jobsOverviewScreen,
  audit: auditScreen,
  list: (app, route) => listScreen(app, resourceOf(app, route)),
  lookup: (app, route) => lookupScreen(app, resourceOf(app, route)),
  detail: (app, route) => detailScreen(app, resourceOf(app, route)),
  create: (app, route) => createScreen(app, route, resourceOf(app, route)),
  edit: (app, route) => editScreen(app, route, resourceOf(app, route)),
  page: (app, route) => {
    const component = route.component;
    // `pages.ts` sets it on every `view: 'page'` it builds; a hand-made route without one is a
    // path with nothing behind it, refused where it would have been mounted.
    if (component === undefined) {
      throw new AdminPagePathInvalidError({
        path: route.path,
        cause: 'is a page route with no component',
        fix: 'declare it in `pages:` on defineAdmin() — { path, titleKey, permissions, component }',
      });
    }
    return guardedScreen(app, route, (request) => component(request));
  },
};

/** The same table as a Map: a view that is not one of the nine has no screen, not a prototype's. */
const SCREEN_BY_VIEW: ReadonlyMap<string, Build> = new Map(Object.entries(SCREENS));

export function screenFor(app: AdminApp, route: AdminRoute): AdminScreen {
  const build = SCREEN_BY_VIEW.get(route.view);
  if (build === undefined) {
    throw new AdminPagePathInvalidError({
      path: route.path,
      cause: `has the view "${route.view}", which no screen renders`,
      fix: 'declare the screen in `pages:` on defineAdmin() — { path, titleKey, permissions, component }',
    });
  }
  return build(app, route);
}
