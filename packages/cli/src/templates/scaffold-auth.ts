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
// every visitor in as an admin. FAILS CLOSED (\`fallback: 'production'\`) rather than trusting
// \`tryResolveEnvironment\`'s own default: that default is \`development\`, so a process that named
// NEITHER \`ULTIMATE_ENV\` nor \`NODE_ENV\` would otherwise read as development too — indistinguishable
// from the one this file exists to allow. \`x dev\` declares \`ULTIMATE_ENV=development\` for exactly
// this reason (whenever neither key is already set), so a bare \`x dev\` still installs this viewer;
// \`bun test\` sets \`NODE_ENV=test\`, so it does not install there either — a fixture mints its own
// actor, and a second one arriving from a cookie would decide which actor a test is about.
//
// REPLACE IT with the real thing: resolve a session cookie to a row, and return that actor.
// Everything downstream — pages, policies, live subscribers, MCP tools — reads what this returns.
import { type Actor, logger, tryResolveEnvironment } from '@ultimat3/core';
import { configureAuthenticator, readCookie } from '@ultimat3/http';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { roles } from '../../shared/roles';

/** Set it to a role \`apps/web/shared/roles.ts\` declares to browse as that role. */
export const DEV_ROLE_COOKIE = '${app.kebab}_dev_role';

/** With NO cookie: the one that can open every scaffolded route, including \`/admin\`. */
export const DEFAULT_DEV_ROLE = 'admin';

/**
 * The roles a cookie may name: the ones \`shared/roles.ts\` declares, read off the map itself. A
 * list spelled here went stale the day a role was added there — the new role was "unknown", and
 * unknown fell back to admin, so browsing as a read-only role silently browsed as the most
 * privileged one.
 */
export const declaredDevRoles = (): readonly string[] => Object.keys(roles);

/**
 * The role a request browses as, or \`undefined\` for a cookie naming a role nobody declared.
 * No cookie at all is the default viewer; a cookie that names something else is a statement this
 * module cannot honour, and it is never answered with more than was asked for.
 */
export const devRoleFrom = (cookieHeader: string | null): string | undefined => {
  const named = readCookie(cookieHeader, DEV_ROLE_COOKIE);
  if (named === null) return DEFAULT_DEV_ROLE;
  // \`Object.hasOwn\`, never \`in\`: a cookie saying \`constructor\` names no role.
  return Object.hasOwn(roles, named) ? named : undefined;
};

/**
 * \`roles\`, never a permission list: \`can()\` expands the role map at decision time, so a grant
 * moved between roles reaches this actor without an edit here.
 */
export const devActorFor = (role: string): Actor => ({
  kind: 'user',
  id: 'dev-actor',
  // The seed's org, never an invented string: a generated tenant policy compares it with a uuid.
  orgId: DEMO_ORG_ID,
  roles: [role],
  // Both required, and both deliberately empty: \`scopes\` is the framework's own escape hatch
  // (\`tenancy:cross\`) and \`permissions\` is a DIRECT grant that bypasses the role map — a
  // development viewer holds exactly what its role holds, and nothing a rule cannot explain.
  scopes: [],
  permissions: [],
});

/** The one method this reads off a request. */
interface HeaderRequest {
  header(name: string): string | null;
}

/**
 * What \`hooks.authenticate\` is handed: the request's cookie header decides the role. Named, and
 * typed by the one method it reads, so a test calls it with a header and no server.
 *
 * A cookie naming an undeclared role answers \`null\` — ANONYMOUS, the least a request can be —
 * and says so, with the value it read and the roles it could have named.
 */
export const devAuthenticate = (request: HeaderRequest): Actor | null => {
  const cookieHeader = request.header('cookie');
  const role = devRoleFrom(cookieHeader);
  if (role !== undefined) return devActorFor(role);
  logger.warn('the development role cookie names no declared role: answering as anonymous', {
    named: readCookie(cookieHeader, DEV_ROLE_COOKIE),
    declared: declaredDevRoles(),
    fix: \`document.cookie = '\${DEV_ROLE_COOKIE}=\${DEFAULT_DEV_ROLE}'   # or declare the role in apps/web/shared/roles.ts\`,
  });
  return null;
};

/**
 * Installs it, and says so — loudly, because a silent stand-in for authentication is the one thing
 * worse than none. Returns whether it installed, so the test can assert both halves.
 */
export function installDevAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (tryResolveEnvironment({ env, fallback: 'production' }) !== 'development') return false;
  configureAuthenticator(devAuthenticate);
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
import { setLogSink } from '@ultimat3/core';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { actorHas } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { roles } from '../../shared/roles';
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_COOKIE,
  declaredDevRoles,
  devActorFor,
  devAuthenticate,
  devRoleFrom,
  installDevAuthenticator,
} from './dev-actor';

unitTest('the cookie names a DECLARED role; with no cookie it is the default viewer', () => {
  expect(devRoleFrom(\`\${DEV_ROLE_COOKIE}=member\`)).toBe('member');
  expect(devRoleFrom(null)).toBe(DEFAULT_DEV_ROLE);
  // Read off the role map, so a role added to shared/roles.ts is one this cookie can name.
  expect(declaredDevRoles()).toEqual(Object.keys(roles));
  expect(declaredDevRoles()).toContain(DEFAULT_DEV_ROLE);
});

unitTest('a cookie naming an undeclared role is never the default viewer', () => {
  // It fell back to admin: a typo, or a role not declared yet, browsed as the most privileged
  // role there is — and a "read-only role cannot write" check passed for the wrong reason.
  for (const named of ['nobody', 'Admin', 'constructor', '']) {
    expect(devRoleFrom(\`\${DEV_ROLE_COOKIE}=\${named}\`)).toBeUndefined();
  }
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
  // FAILS CLOSED: a process naming NEITHER key is production here, never the default-development
  // a bare \`tryResolveEnvironment({ env })\` would answer. \`x dev\` is what makes a real \`x dev\`
  // still install this viewer — it declares \`ULTIMATE_ENV=development\` before this module loads,
  // for exactly the process this call simulates having none of.
  expect(installDevAuthenticator({})).toBe(false);
  expect(configuredAuthenticator()).toBeUndefined();

  expect(installDevAuthenticator({ ULTIMATE_ENV: 'development' })).toBe(true);
  expect(configuredAuthenticator()).toBe(devAuthenticate);
  // Process-global, so the case that installed one takes it back out.
  resetAuthenticator();
});

unitTest('what it installs answers a request from its cookie header, and no other', () => {
  const cookie = \`\${DEV_ROLE_COOKIE}=member\`;
  const request = { header: (name: string) => (name === 'cookie' ? cookie : null) };
  expect(devAuthenticate(request)?.roles).toEqual(['member']);
  // A request with no cookie is the default viewer, never an anonymous one.
  expect(devAuthenticate({ header: () => null })?.roles).toEqual([DEFAULT_DEV_ROLE]);
});

unitTest('an undeclared role is answered as ANONYMOUS, and the log names what it read', () => {
  const lines: Record<string, unknown>[] = [];
  const previous = setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  try {
    const cookie = \`\${DEV_ROLE_COOKIE}=auditor\`;
    expect(devAuthenticate({ header: () => cookie })).toBeNull();
  } finally {
    setLogSink(previous);
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]?.level).toBe('warn');
  expect(lines[0]?.named).toBe('auditor');
  expect(lines[0]?.declared).toEqual(Object.keys(roles));
});
`;

/** The app's development viewer, beside the roles it names. */
export function authFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/app/auth/dev-actor.ts', contents: devActor(app) },
    { path: 'apps/web/app/auth/dev-actor.test.ts', contents: devActorTest() },
  ];
}
