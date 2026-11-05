// What both `x g sign-in` shapes write: where a signed-in browser lands, the sign-out action, the
// boot guard that refuses a people-facing role with sign-in unconfigured, and the page's styles.
// The two shapes differ only in how a person proves who they are (`sign-in-password.ts`,
// `sign-in-oidc.ts`); the session after that is one session, so its edges are written once.

import type { GeneratedFile } from './naming';
import { authModule } from './scaffold-auth';
import { destroySessionTest } from './sign-in-action-tests';

/** Every generated file lives under the scaffold's own auth slice, beside `auth.ts`. */
export const AUTH_DIR = 'apps/web/app/auth';
/** The page `x g sign-in` writes, and what `auth.signInPath` names. */
export const SIGN_IN_PATH = '/auth/sign-in';

/** How the generated page reaches a string: the app's own catalog module, or the framework's. */
export const catalogImport = (module: string | undefined): string =>
  module === undefined
    ? "import { t } from '@ultimat3/i18n';"
    : `import { useT } from '${module}';`;

export const translatorBinding = (module: string | undefined): string =>
  module === undefined ? '' : '\n  const t = useT();';

/** `text` as `//` comment lines of at most 100 columns, split on spaces. */
const commentLines = (text: string): string => {
  const lines: string[] = [];
  let line = '//';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 100) {
      lines.push(line);
      line = '//';
    }
    line = `${line} ${word}`;
  }
  return [...lines, line].join('\n');
};

/**
 * A string-array literal the way Biome prints it after `prefix`: on one line when it fits in 100
 * columns, otherwise one item per line with a trailing comma.
 */
export const arrayLiteral = (prefix: string, items: readonly string[], suffix: string): string => {
  const quoted = items.map((item) => `'${item}'`);
  const inline = `${prefix}[${quoted.join(', ')}]${suffix}`;
  if (inline.length <= 100) return inline;
  const indent = /^\s*/.exec(prefix)?.[0] ?? '';
  const rows = quoted.map((item) => `${indent}  ${item},`).join('\n');
  return `${prefix}[\n${rows}\n${indent}]${suffix}`;
};

const flowSource =
  (): string => `// Where a signed-in browser goes, and the one browser/agent split every sign-in action makes. The
// destination is a FIXED path or a same-origin \`?next=\`: the endpoint that hands out a session is
// the classic open redirect, and \`nextAfterSignIn\` is the framework's one check for it.
import { NEXT_PARAM, nextAfterSignIn, setRedirect, useRequestHeader } from '@ultimat3/http';

/** Where a browser lands with no \`?next=\`. The app's to move. */
export const AFTER_SIGN_IN = '/dashboard';
/** The page this app signs in on — \`auth.signInPath\` in \`app.config.ts\` names the same one. */
export const SIGN_IN_PATH = '${SIGN_IN_PATH}';
export { NEXT_PARAM };

/** A same-origin path to go to next, or the fallback. Never another origin. */
export const nextPath = (raw: string | undefined, fallback = AFTER_SIGN_IN): string =>
  nextAfterSignIn(raw, fallback);

/**
 * A browser that posted the native form gets a 303 to where it was going; an agent that posted
 * JSON gets the same path as data. One operation, two audiences — \`setRedirect\` is that seam.
 */
export const landAt = (path: string): string => {
  if ((useRequestHeader('accept') ?? '').includes('text/html')) setRedirect(path);
  return path;
};
`;

const flowTest =
  (): string => `// The landing rule: a same-origin path is kept, anything else is the fixed destination.
import { expect, unitTest } from '@ultimat3/testing';
import { AFTER_SIGN_IN, nextPath, SIGN_IN_PATH } from './sign-in-flow';

unitTest('a same-origin next is kept, another origin is the fixed landing page', () => {
  expect(nextPath('/posts')).toBe('/posts');
  expect(nextPath('https://evil.example/steal')).toBe(AFTER_SIGN_IN);
  expect(nextPath('//evil.example')).toBe(AFTER_SIGN_IN);
  expect(nextPath(undefined)).toBe(AFTER_SIGN_IN);
  expect(nextPath(undefined, SIGN_IN_PATH)).toBe(SIGN_IN_PATH);
});
`;

const destroySessionSource =
  (): string => `// Sign out: the session row revoked, the cookie expired and the browser's stored state cleared —
// \`signOutHeaders()\` is the one list of what a sign-out response carries. Public, because a
// signed-out caller signing out is a no-op rather than a 401, and a stale tab must not see a 500.
import { action, t } from '@ultimat3/action';
import { logout, signOutHeaders } from '@ultimat3/auth';
import { useRequestContext, useRequestCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { landAt } from '../sign-in-flow';

export const destroySession = action({
  // A native form with no field posts no body, and an action's input is an object: the form
  // declares one field rather than depending on how a browser encodes nothing.
  input: t.object({ confirm: t.literal('sign-out') }),
  output: t.object({ ok: t.boolean, next: t.string, revoked: t.boolean }),
  policy: allow('public'),
  mcp: { expose: false },
  async handle() {
    const auth = appAuth();
    const token = useRequestCookie(auth.sessions.policy.cookieName);
    const revoked = token === null || token === '' ? false : await logout(auth, token);
    const response = useRequestContext('destroySession').headers;
    for (const [name, value] of signOutHeaders({ session: auth.sessions.policy })) {
      response.append(name, value);
    }
    return { ok: true, next: landAt('/'), revoked };
  },
});
`;

/**
 * The guard reads the environment the way the scaffold's authenticator does — `fallback:
 * 'production'` never applies, because only a NAMED deployed environment is refused: \`x manifest\`
 * and \`x verify\` import every module with none named, and must not trip it.
 */
const guardSource = (
  keys: readonly string[],
  why: string,
): string => `// Refuses to start a people-facing role with sign-in unconfigured. Outside \`development\` and \`test\`, a
// \`web\` or \`sync\` process with these keys unset would serve every policy-protected route as a 401
// that nobody can sign in past. Written by \`x g sign-in\` and owned by this app — an API-only app
// has no sign-in, so this is not a framework rule.
${commentLines(why)}
import { signInUnconfigured } from '@ultimat3/auth';

/** The settings sign-in cannot run without. \`bunx x env example\` lists them. */
${arrayLiteral('export const SIGN_IN_ENV: readonly string[] = ', keys, ';')}

/** The roles a person reaches. \`worker\`, \`scheduler\`, \`replicator\` and \`migrate\` sign nobody in. */
const PEOPLE_FACING = new Set(['web', 'sync']);

type Env = Readonly<Record<string, string | undefined>>;

const named = (env: Env, key: string): string => (env[key] ?? '').trim();

/**
 * Throws \`X_AUTH_SIGN_IN_UNCONFIGURED\` naming every unset key, or returns. Only a NAMED deployed
 * environment is judged: \`x manifest\` and \`x verify\` load the app with none named. Called by
 * \`apps/web/runtime.ts\`, which the boot imports before it binds a port — a throw there stops the
 * role, where a throw in a scanned module would only be logged.
 */
export function assertSignInConfigured(env: Env): void {
  const environment = named(env, 'ULTIMATE_ENV') || named(env, 'NODE_ENV');
  if (environment === '' || environment === 'development' || environment === 'test') return;
  // \`ROLE\` unset is \`web\`, exactly as the boot reads it.
  const role = named(env, 'ROLE') || 'web';
  if (!PEOPLE_FACING.has(role)) return;
  const missing = SIGN_IN_ENV.filter((key) => named(env, key) === '');
  if (missing.length > 0) throw signInUnconfigured(role, missing);
}
`;

const guardTest = (
  keys: readonly string[],
): string => `// The guard refuses a deployed people-facing role with sign-in unset, and nothing else.
import { expect, unitTest } from '@ultimat3/testing';
import { assertSignInConfigured, SIGN_IN_ENV } from './sign-in-guard';

const configured = Object.fromEntries(SIGN_IN_ENV.map((key) => [key, 'set']));

const refusal = (env: Readonly<Record<string, string>>): unknown => {
  try {
    assertSignInConfigured(env);
  } catch (error) {
    return error;
  }
  return undefined;
};

unitTest('a deployed web or sync role with sign-in unset refuses to start', () => {
  for (const ROLE of ['web', 'sync']) {
    const error = refusal({ ULTIMATE_ENV: 'production', ROLE });
    expect(error).toBeUltimateError('X_AUTH_SIGN_IN_UNCONFIGURED');
  }
  // \`ROLE\` unset is \`web\`, and \`NODE_ENV\` names the environment as well.
  expect(refusal({ NODE_ENV: 'production' })).toBeUltimateError('X_AUTH_SIGN_IN_UNCONFIGURED');
  expect(refusal({ ULTIMATE_ENV: 'staging', ROLE: 'web' })).toBeUltimateError(
    'X_AUTH_SIGN_IN_UNCONFIGURED',
  );
});

unitTest('configured, local, unnamed, or a role nobody signs in to: it starts', () => {
${arrayLiteral('  expect(SIGN_IN_ENV).toEqual(', keys, ');')}
  expect(refusal({ ULTIMATE_ENV: 'production', ROLE: 'web', ...configured })).toBeUndefined();
  expect(refusal({ ULTIMATE_ENV: 'development', ROLE: 'web' })).toBeUndefined();
  expect(refusal({ NODE_ENV: 'test', ROLE: 'web' })).toBeUndefined();
  expect(refusal({ ROLE: 'web' })).toBeUndefined();
  expect(refusal({ ULTIMATE_ENV: 'production', ROLE: 'worker' })).toBeUndefined();
});
`;

const styleSource =
  (): string => `// Semantic tokens only: a raw colour here is refused by guards/raw-colour.ts.
@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: grid;
  gap: tokens.space(4);
  max-width: 28rem;
  margin-inline: auto;
  padding: tokens.space(6);
  color: tokens.role('fg');
}
`;

/** The files both shapes write, with the guard over this shape's settings. */
/** Where the generated runtime lives: `apps/<app>/runtime.ts` is what both boots read first. */
export const RUNTIME_MODULE = 'apps/web/runtime.ts';

/** The plain routes a shape mounts: an import line, and the expression `routes:` takes. */
export interface RuntimeRoutes {
  readonly importLine: string;
  readonly expression: string;
}

const runtimeSource = (
  routes: RuntimeRoutes | undefined,
): string => `// What this app hands the framework's boot — \`x dev\` and the container both import it before a
// port is bound. The sign-in guard runs HERE for that reason: a throw in this module stops the
// role, where the same throw in a module the app scan imports is logged and the boot goes on.
import { assertSignInConfigured } from './app/auth/sign-in-guard';${routes === undefined ? '' : `\n${routes.importLine}`}

assertSignInConfigured(process.env);

export const runtime = {${routes === undefined ? '' : ` routes: ${routes.expression} `}};
`;

const runtimeTest = (
  routes: RuntimeRoutes | undefined,
): string => `// The runtime loads under test (the guard judges no local environment)${routes === undefined ? '' : ', and mounts the sign-in routes'}.
import { expect, unitTest } from '@ultimat3/testing';
${routes === undefined ? '' : `${routes.importLine}\n`}import { runtime } from './runtime';

unitTest('the runtime loads${routes === undefined ? '' : ' and mounts the sign-in routes'}', () => {
  ${routes === undefined ? 'expect(runtime).toEqual({});' : `expect(runtime.routes).toBe(${routes.expression});`}
});
`;

export function sharedSignInFiles(
  keys: readonly string[],
  why: string,
  routes?: RuntimeRoutes,
): readonly GeneratedFile[] {
  return [
    { path: RUNTIME_MODULE, contents: runtimeSource(routes) },
    { path: 'apps/web/runtime.test.ts', contents: runtimeTest(routes) },
    { path: `${AUTH_DIR}/sign-in-flow.ts`, contents: flowSource() },
    { path: `${AUTH_DIR}/sign-in-flow.test.ts`, contents: flowTest() },
    { path: `${AUTH_DIR}/sign-in-guard.ts`, contents: guardSource(keys, why) },
    { path: `${AUTH_DIR}/sign-in-guard.test.ts`, contents: guardTest(keys) },
    { path: `${AUTH_DIR}/actions/destroy-session.ts`, contents: destroySessionSource() },
    { path: `${AUTH_DIR}/actions/destroy-session.test.ts`, contents: destroySessionTest() },
    { path: `${AUTH_DIR}/sign-in/page.module.scss`, contents: styleSource() },
    // Every action above imports `../auth`; an app from before `x new` wrote it gets it here.
    { path: `${AUTH_DIR}/auth.ts`, contents: authModule(), merge: 'if-absent' },
  ];
}
