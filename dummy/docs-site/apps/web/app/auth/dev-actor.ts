// Who a browser with NO session is under `x dev`: a viewer named by a cookie.
//
// `authenticator.ts` is the real path — a session cookie, resolved by `@ultimat3/auth` — and it
// is installed in every environment. A fresh app issues no session until it has a sign-in page, so
// without this every route declaring a `policy:` answered 401 on the first `x dev`. This module
// only answers; `authenticator.ts` decides when it is asked, and it asks in `development` alone —
// a viewer that followed this to staging would sign every visitor in as an admin.
//
// Delete it the day sign-in exists, and the fallback line in `authenticator.ts` with it.
import { type Actor, logger, readCookie } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { roles } from '../../shared/roles';

/** Set it to a role `apps/web/shared/roles.ts` declares to browse as that role. */
export const DEV_ROLE_COOKIE = 'docs-site_dev_role';

/** With NO cookie: the one that can open every scaffolded route, including `/admin`. */
export const DEFAULT_DEV_ROLE = 'admin';

/**
 * The roles a cookie may name: the ones `shared/roles.ts` declares, read off the map itself. A
 * list spelled here went stale the day a role was added there — the new role was "unknown", and
 * unknown fell back to admin, so browsing as a read-only role silently browsed as the most
 * privileged one.
 */
export const declaredDevRoles = (): readonly string[] => Object.keys(roles);

/**
 * The role a request browses as, or `undefined` for a cookie naming a role nobody declared.
 * No cookie at all is the default viewer; a cookie that names something else is a statement this
 * module cannot honour, and it is never answered with more than was asked for.
 */
export const devRoleFrom = (cookieHeader: string | null): string | undefined => {
  const named = readCookie(cookieHeader, DEV_ROLE_COOKIE);
  if (named === null) return DEFAULT_DEV_ROLE;
  // `Object.hasOwn`, never `in`: a cookie saying `constructor` names no role.
  return Object.hasOwn(roles, named) ? named : undefined;
};

/**
 * The viewer's user id for `role`: a uuid, as `ctx.actor.id` is on every real request (an
 * `x_users` key) — a name here was `22P02 invalid input syntax for type uuid` the first time a
 * handler looked its caller up. `seedId`, so a seed's id('user:dev:<role>') is this very user.
 */
export const devActorId = (role: string): string => seedId(`user:dev:${role}`);

/**
 * `roles`, never a permission list: `can()` expands the role map at decision time, so a grant
 * moved between roles reaches this actor without an edit here.
 */
export const devActorFor = (role: string): Actor => ({
  kind: 'user',
  id: devActorId(role),
  // The seed's org, never an invented string: a generated tenant policy compares it with a uuid.
  orgId: DEMO_ORG_ID,
  roles: [role],
  // Both required, and both deliberately empty: `scopes` is the framework's own escape hatch
  // (`tenancy:cross`) and `permissions` is a DIRECT grant that bypasses the role map — a
  // development viewer holds exactly what its role holds, and nothing a rule cannot explain.
  scopes: [],
  permissions: [],
});

/** The one method this reads off a request. */
export interface HeaderRequest {
  header(name: string): string | null;
}

/**
 * The development viewer for a request: its cookie header decides the role. Typed by the one
 * method it reads, so a test calls it with a header and no server.
 *
 * A cookie naming an undeclared role answers `null` — ANONYMOUS, the least a request can be —
 * and says so, with the value it read and the roles it could have named.
 */
export const devAuthenticate = (request: HeaderRequest): Actor | null => {
  const cookieHeader = request.header('cookie');
  const role = devRoleFrom(cookieHeader);
  if (role !== undefined) return devActorFor(role);
  logger.warn('the development role cookie names no declared role: answering as anonymous', {
    named: readCookie(cookieHeader, DEV_ROLE_COOKIE),
    declared: declaredDevRoles(),
    fix: `document.cookie = '${DEV_ROLE_COOKIE}=${DEFAULT_DEV_ROLE}'   # or declare the role in apps/web/shared/roles.ts`,
  });
  return null;
};
