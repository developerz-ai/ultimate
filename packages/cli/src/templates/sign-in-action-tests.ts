// The tests `x g sign-in` writes for its actions: each handler run in a real request context over
// the app's migrated database, so refused, signed in, second factor owed and signed out are held.
// `destroySessionTest` is both shapes'; the other two are the password shape's. A browser's own
// form is posted through the pipeline (`formPostSource`): its 303 is the action's `native:`.

/** The app's migrated database installed under `db()` for the file, as `page-db.test.ts` does. */
const DATABASE = `// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));
beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
// Back to memory, so this file's database never reaches the next file's unit tests.
afterAll(() => setDbClient(undefined));`;

/** The imports every one of the three files shares, after its own `@ultimat3/auth` line. */
const SHARED_IMPORTS = `import { migratedDatabase } from '@ultimat3/cli';
import { runWithContext } from '@ultimat3/core';
import { setDbClient } from '@ultimat3/db';
import { asCtx, defineHttpConfig, httpServer, requestContext } from '@ultimat3/http';
import { afterAll, beforeAll, expect, reusableDatabase, unitTest } from '@ultimat3/testing';
import { appAuth } from '../auth';`;

/**
 * \`formPost\`: \`target\` posted the way a browser's own \`<form method="post">\` posts it — through
 * the pipeline, so the 303 is what the action's \`native:\` answers. \`actor\` adds the signed-in
 * caller an \`authenticate\` hook would resolve; without it the caller is anonymous.
 */
export const formPostSource = (actor: boolean): string => {
  // Biome's layout: the two-parameter list fits on one line, the three-parameter one does not.
  const signature = actor
    ? '(\n  fields: Record<string, string>,\n  actor: Actor,\n  headers: Record<string, string> = {},\n)'
    : '(fields: Record<string, string>, headers: Record<string, string> = {})';
  const hooks = actor ? '\n    hooks: { authenticate: () => actor },' : '';
  return `/** \`target\` posted as a browser's own form, through the pipeline: its \`native:\` answers. */
const formPost = async ${signature} => {
  const route = toRoute(target);
  const server = httpServer({
    routes: [route],
    config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),${hooks}
  });
  const response = await server.fetch(
    new Request(\`https://app.test\${route.path}\`, {
      method: 'POST',
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://app.test',
        ...headers,
      },
      body: new URLSearchParams(fields),
    }),
  );
  const landed = { status: response.status, location: response.headers.get('location') };
  return { response, landed };
};`;
};

/** The request the pipeline would build, the action run inside it, and both handed back. */
const requestOf = (
  path: string,
  headers: string,
  call: string,
): string => `  const request = requestContext({
    url: new URL('https://app.test${path}'),
    method: 'POST',
    role: 'web',
    config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
    requestHeaders: ${headers},
  });
  const ctx = asCtx(request);
  const output = await runWithContext(ctx, () => ${call});
  return { output, request };`;

export const createSessionTest =
  (): string => `// createSession, run inside a real request over the app's migrated database: a wrong password is
// refused, a right one sets the session cookie, and a second factor still owed holds the challenge.
import { toRoute } from '@ultimat3/action';
import { generateTotpSecret, MFA_CHALLENGE_COOKIE, register, saveTotpSecret } from '@ultimat3/auth';
${SHARED_IMPORTS}
import { SECOND_FACTOR_PATH } from '../sign-in-challenge';
import { AFTER_SIGN_IN } from '../sign-in-flow';
import { createSession } from './create-session';

${DATABASE}

const target = createSession.named('createSession');
const PASSWORD = 'a long scaffold test passphrase';

/** One POST, as the pipeline hands it to the action: the response headers come back with it. */
const post = async (input: Parameters<typeof target>[0]) => {
${requestOf('/auth/sign-in', "{ accept: 'application/json' }", 'target(input, { ctx })')}
};

${formPostSource(false)}

/** A person who can sign in, under an address no other test in this file uses. */
const person = (email: string) => register(appAuth(), { email, password: PASSWORD });

/** Whether the response sets cookie \`name\`. */
const sets = (request: { headers: Headers }, name: string): boolean =>
  request.headers.getSetCookie().some((line) => line.startsWith(\`\${name}=\`));

unitTest('createSession is a declared action', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('createSession');
});

unitTest('createSession takes what its form posts and refuses the rest', async () => {
  await expect(target.input).toAcceptInput({ email: 'ada@example.com', password: 'a passphrase' });
  await expect(target.input).toRejectInput({ email: 'not an address', password: 'a passphrase' });
});

unitTest('a wrong password is refused with the one credential error', async () => {
  await person('wrong@example.com');
  const input = { email: 'wrong@example.com', password: 'not the passphrase' };
  const refused = await post(input).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_UNAUTHENTICATED');
});

unitTest('the right password sets the session cookie and lands where it was going', async () => {
  await person('right@example.com');
  const input = { email: 'right@example.com', password: PASSWORD, next: '/posts' };
  const { output, request } = await post(input);
  expect(output).toEqual({ ok: true, next: '/posts', secondFactor: false });
  expect(sets(request, appAuth().sessions.policy.cookieName)).toBe(true);
  // An agent posting JSON gets the path as data, and no redirect.
  expect(request.redirect).toBeUndefined();
});

unitTest('a browser posting the form is sent on with a 303 and the session', async () => {
  await person('form@example.com');
  const { response, landed } = await formPost({ email: 'form@example.com', password: PASSWORD });
  expect(landed).toEqual({ status: 303, location: AFTER_SIGN_IN });
  expect(sets(response, appAuth().sessions.policy.cookieName)).toBe(true);
});

unitTest('a second factor still owed holds the challenge and sets no session', async () => {
  const user = await person('mfa@example.com');
  await saveTotpSecret(appAuth(), user.id, generateTotpSecret());
  const { output, request } = await post({ email: 'mfa@example.com', password: PASSWORD });
  expect(output).toEqual({ ok: false, next: SECOND_FACTOR_PATH, secondFactor: true });
  expect(sets(request, MFA_CHALLENGE_COOKIE)).toBe(true);
  expect(sets(request, appAuth().sessions.policy.cookieName)).toBe(false);
});
`;

export const confirmSessionTest =
  (): string => `// confirmSession, run inside a real request over the app's migrated database: with no challenge
// held it refuses, a wrong code is refused, and the held challenge plus the right code signs in.
// The challenge and its cookie's name are auth's, whichever shape's first leg held it.
import { toRoute } from '@ultimat3/action';
import {
  generateTotpSecret,
  login,
  MFA_CHALLENGE_COOKIE,
  mfaChallengeOf,
  register,
  saveTotpSecret,
  totpCode,
  totpStep,
} from '@ultimat3/auth';
${SHARED_IMPORTS}
import { confirmSession } from './confirm-session';

${DATABASE}

const target = confirmSession.named('confirmSession');
const PASSWORD = 'a long scaffold test passphrase';

/** One POST carrying \`cookie\`, as the pipeline hands it to the action. */
const post = async (input: Parameters<typeof target>[0], cookie?: string) => {
${requestOf(
  '/auth/sign-in/second-factor',
  "{ accept: 'application/json', ...(cookie === undefined ? {} : { cookie }) }",
  'target(input, { ctx })',
)}
};

${formPostSource(false)}

/** A person with a second factor, and the cookie holding the challenge the first leg sealed. */
const challenged = async (email: string) => {
  const user = await register(appAuth(), { email, password: PASSWORD });
  const secret = generateTotpSecret();
  await saveTotpSecret(appAuth(), user.id, secret);
  const first = await login(appAuth(), { email, password: PASSWORD }).catch((e: unknown) => e);
  const challenge = mfaChallengeOf(first);
  expect(challenge).not.toBeNull();
  return { secret, cookie: \`\${MFA_CHALLENGE_COOKIE}=\${challenge}\` };
};

unitTest('confirmSession is a declared action', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('confirmSession');
});

unitTest('confirmSession takes what its form posts and refuses the rest', async () => {
  await expect(target.input).toAcceptInput({ code: '123456' });
  await expect(target.input).toRejectInput({});
});

unitTest('a code with no challenge held is refused before anything is checked', async () => {
  const refused = await post({ code: '123456' }).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_UNAUTHENTICATED');
});

unitTest('a wrong code against the held challenge is refused, and signs nobody in', async () => {
  const { cookie } = await challenged('guess@example.com');
  // Not six digits, so it is read as a recovery code — and this person was issued none.
  const refused = await post({ code: 'not-a-recovery-code' }, cookie).catch((e: unknown) => e);
  expect(refused).toBeUltimateError('X_UNAUTHENTICATED');
});

unitTest('the held challenge and the right code sign in, and drop the challenge', async () => {
  const { secret, cookie } = await challenged('second@example.com');
  const code = totpCode(secret, totpStep(new Date()));
  const { output, request } = await post({ code, next: '/posts' }, cookie);
  expect(output).toEqual({ ok: true, next: '/posts' });
  const session = appAuth().sessions.policy.cookieName;
  const lines = request.headers.getSetCookie();
  expect(lines.some((line) => line.startsWith(\`\${session}=\`))).toBe(true);
  // Cleared, an empty value: the challenge is spent, and a reload starts the sign-in over.
  expect(lines.some((line) => line.startsWith(\`\${MFA_CHALLENGE_COOKIE}=;\`))).toBe(true);
});

unitTest('a browser posting the second-factor form is sent on with a 303', async () => {
  const { secret, cookie } = await challenged('second-form@example.com');
  const code = totpCode(secret, totpStep(new Date()));
  const { landed } = await formPost({ code, next: '/posts' }, { cookie });
  expect(landed).toEqual({ status: 303, location: '/posts' });
});
`;

export const destroySessionTest =
  (): string => `// destroySession, run inside a real request over the app's migrated database: a live session is
// revoked, and a caller with none still signs out — cleared, and landed at the home page.
import { toRoute } from '@ultimat3/action';
import { login, register } from '@ultimat3/auth';
${SHARED_IMPORTS}
import { destroySession } from './destroy-session';

${DATABASE}

const target = destroySession.named('destroySession');

/** One sign-out POST carrying \`cookie\`, as the pipeline hands it to the action. */
const signOut = async (cookie?: string) => {
${requestOf(
  '/auth/sign-out',
  "{ accept: 'application/json', ...(cookie === undefined ? {} : { cookie }) }",
  "target({ confirm: 'sign-out' }, { ctx })",
)}
};

${formPostSource(false)}

unitTest('destroySession is a declared action off the MCP surface', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('destroySession');
});

unitTest('it takes the one statement a sign-out form sends', async () => {
  await expect(target.input).toAcceptInput({ confirm: 'sign-out' });
  await expect(target.input).toRejectInput({});
  await expect(target.input).toRejectInput({ confirm: 'yes' });
});

unitTest('a live session is revoked, and a second sign-out finds nothing to revoke', async () => {
  const password = 'a long scaffold test passphrase';
  await register(appAuth(), { email: 'leaving@example.com', password });
  const { token } = await login(appAuth(), { email: 'leaving@example.com', password });
  const cookie = \`\${appAuth().sessions.policy.cookieName}=\${token}\`;
  const { output } = await signOut(cookie);
  expect(output).toEqual({ ok: true, next: '/', revoked: true });
  expect((await signOut(cookie)).output.revoked).toBe(false);
});

unitTest('with no session it still signs out, and a browser lands at the home page', async () => {
  expect((await signOut()).output).toEqual({ ok: true, next: '/', revoked: false });
  const { response, landed } = await formPost({ confirm: 'sign-out' });
  expect(landed).toEqual({ status: 303, location: '/' });
  // The expired session cookie and the cleared browser state, whether or not a session existed.
  const expired = \`\${appAuth().sessions.policy.cookieName}=;\`;
  expect(response.headers.getSetCookie().some((line) => line.startsWith(expired))).toBe(true);
  expect(response.headers.get('clear-site-data')).not.toBeNull();
});
`;
