// `/admin/ops` — the MOUNT, not the page. The screen itself is `../pages/ops`, declared as a
// `pages:` entry on `defineAdmin`; everything this file exports comes out of the route table that
// declaration built.
//
// That is the whole point. `config` is the `defineRoute` `routes.ts` composed — with `policy`
// already set from `pagePermissions()` — and `render` is the `guardedPage()` wrapper, which asks
// the same `decideAll` every CRUD call asks and audits the refusal. Until 1.2.0 this file wrote
// both by hand: its own `defineRoute`, its own `policy:` line and its own `pageDecision('job')`
// branch. All three were correct and none was enforced, which is the privilege hole `pages:`
// closes — a custom admin page that forgets one of them now cannot exist.

import {
  type AdminPageComponent,
  AdminPagePathInvalidError,
  type AdminRouteConfig,
  adminRouteFor,
} from '@ultimat3/admin';
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
  return { config: route.config, render: route.component };
}

const ops = mountedOps();

export const config = ops.config;

/**
 * The frame around the guarded page. The shell is this app's — nav, actor label, title — and the
 * body is whatever `guardedPage()` returned: the board for an operator who holds `job:read`, and
 * `AdminPageDenied` naming the permission for one who does not.
 */
export async function Page(props: {
  readonly params: Readonly<Record<string, string>>;
  readonly url: string;
}): Promise<JSX.Element> {
  const body = await ops.render({
    ctx: adminCtxForRequest(),
    params: props.params,
    url: props.url,
  });

  return (
    <AdminShell titleKey={opsPage.titleKey} nav={visibleNavFor()} actorLabel={actorLabel()}>
      {body}
    </AdminShell>
  );
}
