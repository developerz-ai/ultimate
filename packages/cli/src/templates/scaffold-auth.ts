// The scaffold's answer to "who is this?", which it did not have.
//
// `hooks.authenticate` is the ONLY place an actor can come from, and nothing in a generated app
// called `configureAuthenticator()` — so a fresh `x new` booted with
// `X_CONFIG_INVALID: 7 route(s) declare auth: 'required' and no authenticator is configured` on
// every start, and its own `/dashboard` answered 401 on the first click. The scaffold declares the
// routes and the roles; this is the missing third piece, and it is deliberately the smallest one
// that can be honest: a viewer named by a cookie, installed in `development` and nowhere else.
//
// The alternative — dropping `policy:` from the scaffolded routes — was refused: a dashboard that
// declares no policy is registered `auth: 'public'`, which also skips `render-ssr`'s gated branch,
// so the document ships with no `vary: cookie` and a shared cache may hand one visitor's page to
// the next. The scaffold would teach the wrong shape to every app that starts from it.

import type { GeneratedFile, NameSet } from './naming';

const devActor = (
  app: NameSet,
): string => `// Who a browser is until this app issues sessions of its own.
//
// \`hooks.authenticate\` is the one place an actor can come from. Without it every request is
// anonymous, so each route declaring a \`policy:\` answers 401 and the boot warns
// \`X_CONFIG_INVALID\` — which is what a scaffolded app did on its very first \`x dev\`.
//
// DEVELOPMENT ONLY, and the guard is the point: a viewer that followed this to staging would sign
// every visitor in as an admin. \`bun test\` sets \`NODE_ENV=test\`, so it does not install there
// either — a fixture mints its own actor, and a second one arriving from a cookie would decide
// which actor a test is about.
//
// REPLACE IT with the real thing: resolve a session cookie to a row, and return that actor.
// Everything downstream — pages, policies, live subscribers, MCP tools — reads what this returns.
import { type Actor, logger, tryResolveEnvironment } from '@ultimat3/core';
import { configureAuthenticator, readCookie } from '@ultimat3/http';

/** Set it to a role from \`apps/web/shared/roles.ts\` to browse as that role. */
export const DEV_ROLE_COOKIE = '${app.kebab}_dev_role';

/** The roles \`shared/roles.ts\` declares. A cookie naming anything else falls back. */
export const DEV_ROLES = ['member', 'admin'] as const;

export type DevRole = (typeof DEV_ROLES)[number];

/** The one that can open every scaffolded route, including \`/admin\`. */
export const DEFAULT_DEV_ROLE: DevRole = 'admin';

const isDevRole = (value: string | null): value is DevRole =>
  value !== null && (DEV_ROLES as readonly string[]).includes(value);

/**
 * An unknown cookie value falls back rather than refusing: the cookie is a viewing convenience,
 * and a typo that resolved nobody would reproduce the 401 this module exists to remove.
 */
export const devRoleFrom = (cookieHeader: string | null): DevRole => {
  const named = readCookie(cookieHeader, DEV_ROLE_COOKIE);
  return isDevRole(named) ? named : DEFAULT_DEV_ROLE;
};

/**
 * \`roles\`, never a permission list: \`can()\` expands the role map at decision time, so a grant
 * moved between roles reaches this actor without an edit here.
 */
export const devActorFor = (role: DevRole): Actor => ({
  kind: 'user',
  id: 'dev-actor',
  orgId: 'dev-org',
  roles: [role],
  // Both required, and both deliberately empty: \`scopes\` is the framework's own escape hatch
  // (\`tenancy:cross\`) and \`permissions\` is a DIRECT grant that bypasses the role map — a
  // development viewer holds exactly what its role holds, and nothing a rule cannot explain.
  scopes: [],
  permissions: [],
});

/**
 * Installs it, and says so — loudly, because a silent stand-in for authentication is the one thing
 * worse than none. Returns whether it installed, so the test can assert both halves.
 */
export function installDevAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (tryResolveEnvironment({ env }) !== 'development') return false;
  configureAuthenticator((request) => devActorFor(devRoleFrom(request.header('cookie'))));
  logger.warn('every request is answered as a development viewer', {
    role: DEFAULT_DEV_ROLE,
    cause:
      'apps/web/app/auth/dev-actor.ts installs a viewer in development only, because this app issues no session yet',
    fix: \`browse as someone else: document.cookie = '\${DEV_ROLE_COOKIE}=member'\`,
  });
  return true;
}

// Module scope, which IS the wiring: the boot scan imports every module under \`apps/*\` before a
// listener binds, and \`x dev\` and the container both read the configured value back at start.
installDevAuthenticator();
`;

const devActorTest =
  (): string => `// The two halves that make a development-only stand-in safe: it resolves the cookie, and it does
// not install itself anywhere but development.
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { actorHas } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { roles } from '../../shared/roles';
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_COOKIE,
  devActorFor,
  devRoleFrom,
  installDevAuthenticator,
} from './dev-actor';

unitTest('the cookie names the role, and anything else falls back', () => {
  expect(devRoleFrom(\`\${DEV_ROLE_COOKIE}=member\`)).toBe('member');
  expect(devRoleFrom(\`\${DEV_ROLE_COOKIE}=nobody\`)).toBe(DEFAULT_DEV_ROLE);
  expect(devRoleFrom(null)).toBe(DEFAULT_DEV_ROLE);
});

unitTest('the actor it mints holds what the role map grants it, and nothing else', () => {
  // \`actorHas\` and not \`holds\`: this is the function \`can()\` itself calls, so the assertion is
  // the pipeline's own decision rather than a second implementation of it. The map is passed
  // explicitly — a test that depended on which module imported first would pass alone and fail
  // inside a suite.
  expect(actorHas(devActorFor('admin'), 'admin:read', roles)).toBe(true);
  expect(actorHas(devActorFor('member'), 'dashboard:read', roles)).toBe(true);
  // The whole reason this is development-only: a member is not an admin, and neither is a deploy.
  expect(actorHas(devActorFor('member'), 'admin:read', roles)).toBe(false);
});

unitTest('it installs in development and in no other environment', () => {
  // This process is \`test\`, so the module-scope call at the bottom of dev-actor.ts installed
  // nothing — which is what keeps a fixture's own actor the only one a test can be about.
  expect(configuredAuthenticator()).toBeUndefined();

  expect(installDevAuthenticator({ ULTIMATE_ENV: 'production' })).toBe(false);
  expect(installDevAuthenticator({ ULTIMATE_ENV: 'staging' })).toBe(false);
  expect(configuredAuthenticator()).toBeUndefined();

  expect(installDevAuthenticator({ ULTIMATE_ENV: 'development' })).toBe(true);
  expect(configuredAuthenticator()).toBeDefined();
  // Process-global, so the case that installed one takes it back out.
  resetAuthenticator();
});
`;

/** The app's development viewer, beside the roles it names. */
export function authFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/app/auth/dev-actor.ts', contents: devActor(app) },
    { path: 'apps/web/app/auth/dev-actor.test.ts', contents: devActorTest() },
  ];
}
