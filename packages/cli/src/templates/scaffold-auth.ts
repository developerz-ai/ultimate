// The scaffold's answer to "who is this?": a session cookie, resolved by `@ultimat3/auth` over the
// framework's own `x_users` / `x_sessions` tables, installed in EVERY environment.
//
// `hooks.authenticate` is the ONLY place an actor can come from, and a fresh `x new` once installed
// nothing there — `X_CONFIG_INVALID: 7 route(s) declare auth: 'required' and no authenticator is
// configured` on every start, and a 401 on its own `/dashboard`. The first answer was a viewer
// named by a cookie, installed in `development` alone, which left every other environment with no
// authenticator at all and the real path for the app's author to invent. Now the real path is the
// one installed, and the development viewer is only what a request with NO session is answered as
// under `x dev` — so `x dev` stays zero-config and nothing has to be swapped out before a deploy.
//
// Dropping `policy:` from the scaffolded routes was refused: a dashboard that declares no policy is
// registered `auth: 'public'`, which also skips `render-ssr`'s gated branch, so the document ships
// with no `vary: cookie` and a shared cache may hand one visitor's page to the next.

import type { GeneratedFile, NameSet } from './naming';

const devActor = (
  app: NameSet,
): string => `// Who a browser with NO session is under \`x dev\`: a viewer named by a cookie.
//
// \`authenticator.ts\` is the real path — a session cookie, resolved by \`@ultimat3/auth\` — and it
// is installed in every environment. A fresh app issues no session until it has a sign-in page, so
// without this every route declaring a \`policy:\` answered 401 on the first \`x dev\`. This module
// only answers; \`authenticator.ts\` decides when it is asked, and it asks in \`development\` alone —
// a viewer that followed this to staging would sign every visitor in as an admin.
//
// Delete it the day sign-in exists, and the fallback line in \`authenticator.ts\` with it.
import { type Actor, logger } from '@ultimat3/core';
import { readCookie } from '@ultimat3/http';
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
export interface HeaderRequest {
  header(name: string): string | null;
}

/**
 * The development viewer for a request: its cookie header decides the role. Typed by the one
 * method it reads, so a test calls it with a header and no server.
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
`;

const authModule =
  (): string => `// This app's one \`@ultimat3/auth\` instance: sessions, passwords and the lockout, over the
// framework's own \`x_users\` and \`x_sessions\` tables — \`x dev\` and \`ROLE=migrate\` apply them.
//
// Sign-in is one call once the app has a page for it: \`login(appAuth(), { email, password, ip })\`
// answers \`{ token, cookie }\` — set \`cookie\` on the response and every request after it is that
// user, through \`authenticator.ts\`. \`register(appAuth(), { email, password, orgId, roles })\`
// creates one.
import { type Auth, BuiltinAdapter, defineAuth } from '@ultimat3/auth';

let built: Auth | undefined;

/**
 * Built on first use, never at import: the boot scan imports this module before the database and
 * the host's shared lockout limiter are installed, and \`defineAuth\` reads both.
 */
export const appAuth = (): Auth => {
  built ??= defineAuth({ adapter: new BuiltinAdapter() });
  return built;
};
`;

const authenticatorModule =
  (): string => `// Who a request is: the session its cookie names, resolved by \`@ultimat3/auth\` — the one
// authenticator this app installs, in every environment. Everything downstream (pages, policies,
// live subscribers, MCP tools) reads the actor this returns.
//
// With NO session cookie the request is anonymous — except under \`x dev\`, where it is the
// development viewer (\`dev-actor.ts\`), so a fresh app opens its own dashboard with nothing
// configured. That fallback FAILS CLOSED (\`fallback: 'production'\`): \`tryResolveEnvironment\`'s own
// default is \`development\`, so a process naming NEITHER \`ULTIMATE_ENV\` nor \`NODE_ENV\` would
// otherwise read as development too. \`x dev\` declares \`ULTIMATE_ENV=development\` for exactly this
// reason, and \`bun test\` sets \`NODE_ENV=test\`, where a fixture mints its own actor.
import { type Auth, authenticate } from '@ultimat3/auth';
import { type Actor, logger, tryResolveEnvironment } from '@ultimat3/core';
import { configureAuthenticator } from '@ultimat3/http';
import { appAuth } from './auth';
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_COOKIE,
  devAuthenticate,
  type HeaderRequest,
} from './dev-actor';

/** The two methods this reads off a request. */
export interface SessionRequest extends HeaderRequest {
  cookie(name: string): string | null;
}

export interface SessionAuthenticatorOptions {
  /** The app's \`Auth\`, asked for per request so it is built after the boot, not at import. */
  readonly auth: () => Auth;
  /** Whether a request with no session is the development viewer rather than anonymous. */
  readonly development: boolean;
}

/**
 * A session cookie is that session's user, or \`X_SESSION_UNKNOWN\` for one that is expired, revoked
 * or forged — never a fallback to anyone else. No cookie is the development viewer or nobody.
 */
export const sessionAuthenticator =
  (options: SessionAuthenticatorOptions) =>
  async (request: SessionRequest): Promise<Actor | null> => {
    const auth = options.auth();
    const token = request.cookie(auth.sessions.policy.cookieName);
    if (token !== null && token.length > 0) return await authenticate(auth, token);
    return options.development ? devAuthenticate(request) : null;
  };

/**
 * Installs the session authenticator, and returns whether the development fallback is on — so the
 * test can assert both halves. Loud when it is, because a stand-in for a session is the one thing
 * an operator must never find in a log they did not expect it in.
 */
export function installAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  auth: () => Auth = appAuth,
): boolean {
  const development = tryResolveEnvironment({ env, fallback: 'production' }) === 'development';
  configureAuthenticator(sessionAuthenticator({ auth, development }));
  if (development) {
    logger.warn('a request with no session is answered as a development viewer', {
      role: DEFAULT_DEV_ROLE,
      cause:
        'apps/web/app/auth/authenticator.ts falls back to dev-actor.ts in development, because this app has no sign-in page yet',
      fix: \`browse as someone else: document.cookie = '\${DEV_ROLE_COOKIE}=member'\`,
    });
  }
  return development;
}

// Module scope, which IS the wiring: the boot scan imports every module under \`apps/*\` before a
// listener binds, and \`x dev\` and the container both read the configured value back at start.
installAuthenticator();
`;

const devActorTest =
  (): string => `// The development viewer is safe because of what it refuses: a role nobody declared is never the
// default viewer, and the actor it mints holds what its role holds and nothing else. WHEN it is
// asked is \`authenticator.ts\`'s, and \`authenticator.test.ts\` holds that half.
import { setLogSink } from '@ultimat3/core';
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

unitTest('it answers a request from its cookie header, and no other', () => {
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

const authenticatorTest =
  (): string => `// The real path and its one fallback: a session cookie is its user in every environment, a bad
// one is refused rather than replaced, and only development answers a request with no session.
import { defineAuth, login, MemoryAdapter, register } from '@ultimat3/auth';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { installAuthenticator, sessionAuthenticator } from './authenticator';
import { DEFAULT_DEV_ROLE, DEV_ROLE_COOKIE } from './dev-actor';

/** In memory: the session half is the package's, and this test is about the wiring around it. */
const memoryAuth = () => {
  const auth = defineAuth({ adapter: new MemoryAdapter() });
  return () => auth;
};

/** A request carrying exactly these cookies, through both methods the authenticator reads. */
const requestWith = (cookies: Readonly<Record<string, string>>) => ({
  header: (name: string) =>
    name === 'cookie' && Object.keys(cookies).length > 0
      ? Object.entries(cookies)
          .map(([key, value]) => \`\${key}=\${value}\`)
          .join('; ')
      : null,
  cookie: (name: string) => cookies[name] ?? null,
});

const PASSWORD = 'a long scaffold test passphrase';

unitTest('a session cookie is the user it was issued to, in every environment', async () => {
  const auth = memoryAuth();
  const user = await register(auth(), {
    email: 'ada@example.com',
    password: PASSWORD,
    orgId: DEMO_ORG_ID,
    roles: ['member'],
  });
  const { token } = await login(auth(), { email: 'ada@example.com', password: PASSWORD });
  const request = requestWith({ [auth().sessions.policy.cookieName]: token });
  for (const development of [true, false]) {
    const actor = await sessionAuthenticator({ auth, development })(request);
    expect(actor?.id).toBe(user.id);
    expect(actor?.roles).toEqual(['member']);
  }
});

unitTest('a cookie naming no live session is refused, never answered as the viewer', async () => {
  const auth = memoryAuth();
  const request = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });
  await expect(sessionAuthenticator({ auth, development: true })(request)).rejects.toMatchObject({
    code: 'X_UNAUTHENTICATED',
  });
});

unitTest('no session: the development viewer under x dev, anonymous anywhere else', async () => {
  const auth = memoryAuth();
  const member = requestWith({ [DEV_ROLE_COOKIE]: 'member' });
  expect((await sessionAuthenticator({ auth, development: true })(member))?.roles).toEqual([
    'member',
  ]);
  const none = requestWith({});
  expect((await sessionAuthenticator({ auth, development: true })(none))?.roles).toEqual([
    DEFAULT_DEV_ROLE,
  ]);
  expect(await sessionAuthenticator({ auth, development: false })(member)).toBeNull();
});

unitTest('it installs in every environment; only development turns the fallback on', () => {
  const auth = memoryAuth();
  try {
    expect(installAuthenticator({ ULTIMATE_ENV: 'production' }, auth)).toBe(false);
    expect(configuredAuthenticator()).toBeDefined();
    expect(installAuthenticator({ ULTIMATE_ENV: 'staging' }, auth)).toBe(false);
    // FAILS CLOSED: a process naming NEITHER key is production here, never the default-development
    // a bare \`tryResolveEnvironment({ env })\` would answer. \`x dev\` declares
    // \`ULTIMATE_ENV=development\` before this module loads, for exactly the process this simulates.
    expect(installAuthenticator({}, auth)).toBe(false);
    expect(installAuthenticator({ ULTIMATE_ENV: 'development' }, auth)).toBe(true);
  } finally {
    // Process-global, so the case that installed one takes it back out.
    resetAuthenticator();
  }
});
`;

/** The app's authenticator, its \`Auth\`, and the development viewer it falls back to. */
export function authFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/app/auth/auth.ts', contents: authModule() },
    { path: 'apps/web/app/auth/authenticator.ts', contents: authenticatorModule() },
    { path: 'apps/web/app/auth/authenticator.test.ts', contents: authenticatorTest() },
    { path: 'apps/web/app/auth/dev-actor.ts', contents: devActor(app) },
    { path: 'apps/web/app/auth/dev-actor.test.ts', contents: devActorTest() },
  ];
}
