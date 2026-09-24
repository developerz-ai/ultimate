// `/admin/ops` — the MOUNT, not the page. The screen itself is `../pages/ops`, declared as a
// `pages:` entry on `defineAdmin`; everything this file exports comes out of the route table that
// declaration built.
//
// That is the whole point. `config` is the route `routes.ts` composed — its `policy` set from
// `pagePermissions()` — re-declared only to add the `load` that resolves the body, and `render` is
// the `guardedPage()` wrapper, which asks the same `decideAll` every CRUD call asks and audits the
// refusal. Until 1.2.0 this file wrote
// both by hand: its own `defineRoute`, its own `policy:` line and its own `pageDecision('job')`
// branch. All three were correct and none was enforced, which is the privilege hole `pages:`
// closes — a custom admin page that forgets one of them now cannot exist.

import {
  type AdminPageComponent,
  AdminPagePathInvalidError,
  type AdminRouteConfig,
  adminRouteFor,
} from '@ultimat3/admin';
import { defineRoute } from '@ultimat3/render';
import type { JSX } from 'solid-js';
import { admin, adminCtxForRequest } from '../admin';
import { actorLabel } from '../label';
import { opsPage } from '../pages/ops';
import { visibleNavFor } from '../screen';
import { AdminShell } from '../views';

const OPS_PATH = `${admin.basePath}${opsPage.path}`;

/**
 * The route `defineAdmin` built for this page, or the failure that names the missing wiring. A
 * `find` that answered `undefined` and rendered nothing would be the unguarded second way in all
 * over again, one release later — so the missing-route half is `adminRouteFor()`'s own refusal
 * now, the same lookup every other admin page in this app reads its gate from. What stays here is
 * the half only this file can judge: a path the table DOES declare, as a generated view rather
 * than as a guarded page, has no component to render and must not fall back to one.
 */
function mountedOps(): {
  readonly config: AdminRouteConfig['config'];
  readonly policy: AdminRouteConfig['policy'];
  readonly render: AdminPageComponent;
} {
  const route = adminRouteFor(admin, OPS_PATH);
  if (route.component === null) {
    throw new AdminPagePathInvalidError({
      path: opsPage.path,
      cause: 'is a generated view, not a guarded page',
      fix: 'add opsPage to `pages:` in apps/admin/app/admin/admin.ts',
    });
  }
  return { config: route.config, policy: route.policy, render: route.component };
}

const ops = mountedOps();

/**
 * The table's route, with the guarded page's body as its `load`: the same render, mode, budget,
 * offline strategy, meta and — the half `route-policy.test.ts` pins — the same gate, read off the
 * route `defineAdmin` built rather than typed here. The body is resolved once per render, inside
 * the request's context, and the component below only frames it.
 */
export const config = defineRoute({
  render: ops.config.render,
  offline: ops.config.offline,
  hydrate: ops.config.hydrate,
  budget: ops.config.budget,
  // Never optional here: `AdminRouteConfig.policy` is the composed gate, not `RouteConfig`'s maybe.
  policy: ops.policy,
  load: async ({ params, url }): Promise<{ readonly body: JSX.Element }> => ({
    body: await ops.render({ ctx: adminCtxForRequest(), params, url }),
  }),
  meta: ops.config.meta,
});

/**
 * The frame around the guarded page. The shell is this app's — nav, actor label, title — and the
 * body is whatever `guardedPage()` returned: the board for an operator who holds `job:read`, and
 * `AdminPageDenied` naming the permission for one who does not.
 */
export function Page(props: { readonly data: { readonly body: JSX.Element } }): JSX.Element {
  return (
    <AdminShell titleKey={opsPage.titleKey} nav={visibleNavFor()} actorLabel={actorLabel()}>
      {props.data.body}
    </AdminShell>
  );
}
