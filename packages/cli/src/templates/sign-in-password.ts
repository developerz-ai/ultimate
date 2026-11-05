// `x g sign-in --password`: an address and a password over `login()`, the second leg over
// `completeMfa()`, and the two native-form pages that post at them. No island: the browser's own
// form handling is the client, so the pages ship 0 bytes of script.

import { catalogJson } from './catalog-json';
import { catalogPath } from './locales';
import type { GeneratedFile } from './naming';
import {
  SIGN_IN_CATALOG,
  type SignInForm,
  type SignInTemplateOptions,
  secondFactorSource,
  signInPageSource,
  signInPageTest,
} from './sign-in-pages';
import { AUTH_DIR, SIGN_IN_PATH, sharedSignInFiles } from './sign-in-shared';

/** The master key seals the second-factor challenge between the two legs. */
export const PASSWORD_SIGN_IN_ENV: readonly string[] = ['ULTIMATE_SECRETS_KEY'];

const challengeSource =
  (): string => `// The second-factor challenge between the two legs: a sealed, five-minute credential \`login()\`
// hands back inside \`X_MFA_REQUIRED\`, carried in an HttpOnly cookie rather than a URL a log keeps.
import { MFA_CHALLENGE_TTL_MS } from '@ultimat3/auth';
import { isUltimateError } from '@ultimat3/core';
import { deleteCookie, setCookie, useRequestCookie } from '@ultimat3/http';

export const MFA_CHALLENGE_COOKIE = 'x_mfa_challenge';
export const SECOND_FACTOR_PATH = '${SIGN_IN_PATH}/second-factor';

/** The sealed challenge an \`X_MFA_REQUIRED\` carries, or \`null\` for any other throw. */
export const challengeOf = (error: unknown): string | null => {
  if (!isUltimateError(error) || error.code !== 'X_MFA_REQUIRED') return null;
  const challenge = error.meta?.['challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
};

export const holdChallenge = (challenge: string): void =>
  setCookie(MFA_CHALLENGE_COOKIE, challenge, { maxAge: Math.floor(MFA_CHALLENGE_TTL_MS / 1000) });

export const heldChallenge = (): string | null => {
  const value = useRequestCookie(MFA_CHALLENGE_COOKIE);
  return value === null || value === '' ? null : value;
};

export const dropChallenge = (): void => deleteCookie(MFA_CHALLENGE_COOKIE);
`;

const challengeTest =
  (): string => `// Only an X_MFA_REQUIRED carrying a challenge is a second leg; every other throw is not.
import { UltimateError } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { challengeOf } from './sign-in-challenge';

const coded = (code: string, meta?: Record<string, unknown>) =>
  new UltimateError({ code, cause: 'a test throw', fix: 'none', ...(meta ? { meta } : {}) });

unitTest('a sealed challenge is read off X_MFA_REQUIRED, and nothing else is one', () => {
  expect(challengeOf(coded('X_MFA_REQUIRED', { challenge: 'sealed' }))).toBe('sealed');
  expect(challengeOf(coded('X_MFA_REQUIRED'))).toBeNull();
  expect(challengeOf(coded('X_UNAUTHENTICATED', { challenge: 'sealed' }))).toBeNull();
  expect(challengeOf('X_MFA_REQUIRED')).toBeNull();
});
`;

const createSessionSource =
  (): string => `// Sign in with an address and a password. \`login()\` is the whole check — the hash, the lockout and
// one indistinguishable \`X_UNAUTHENTICATED\` for every way a credential is wrong. A second factor
// still owed stops here with the sealed challenge held for the next page.
import { action, t } from '@ultimat3/action';
import { login } from '@ultimat3/auth';
import { useRequestContext } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { challengeOf, holdChallenge, SECOND_FACTOR_PATH } from '../sign-in-challenge';
import { landAt, NEXT_PARAM, nextPath } from '../sign-in-flow';

export const createSession = action({
  input: t.object({
    email: t.email,
    password: t.string.min(1).max(1024),
    [NEXT_PARAM]: t.optional(t.string.max(2048)),
  }),
  output: t.object({ ok: t.boolean, next: t.string, secondFactor: t.boolean }),
  // Public by declaration: signing in is the one operation nobody holds a permission for yet.
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ input }) {
    const request = useRequestContext('createSession');
    try {
      const signedIn = await login(appAuth(), {
        email: input.email,
        password: input.password,
        ip: request.ip,
      });
      request.headers.append('set-cookie', signedIn.cookie);
      return { ok: true, next: landAt(nextPath(input[NEXT_PARAM])), secondFactor: false };
    } catch (error) {
      const challenge = challengeOf(error);
      if (challenge === null) throw error;
      holdChallenge(challenge);
      return { ok: false, next: landAt(SECOND_FACTOR_PATH), secondFactor: true };
    }
  },
});
`;

const confirmSessionSource =
  (): string => `// The second leg: the six digits (or one recovery code) against the challenge the first leg held.
// \`completeMfa()\` meters the guess against the same lockout a password guess spends.
import { action, t } from '@ultimat3/action';
import { authUnauthenticated, completeMfa } from '@ultimat3/auth';
import { useRequestContext } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { dropChallenge, heldChallenge } from '../sign-in-challenge';
import { landAt, NEXT_PARAM, nextPath } from '../sign-in-flow';

export const confirmSession = action({
  input: t.object({
    code: t.string.min(1).max(64),
    [NEXT_PARAM]: t.optional(t.string.max(2048)),
  }),
  output: t.object({ ok: t.boolean, next: t.string }),
  policy: allow('public'),
  mcp: { expose: false },
  async handle({ input }) {
    const request = useRequestContext('confirmSession');
    const challenge = heldChallenge();
    if (challenge === null) throw authUnauthenticated('POST confirmSession');
    const signedIn = await completeMfa(appAuth(), challenge, input.code, { ip: request.ip });
    dropChallenge();
    request.headers.append('set-cookie', signedIn.cookie);
    return { ok: true, next: landAt(nextPath(input[NEXT_PARAM])) };
  },
});
`;

const actionTest = (
  name: string,
  file: string,
  accepted: string,
  refused: string,
): string => `// ${name}'s declared shape: public, off the MCP surface, and the input it refuses. The handler
// runs inside a request; packages/cli/e2e/sign-in.e2e.test.ts drives it over HTTP.
import { expect, unitTest } from '@ultimat3/testing';
import { ${name} } from './${file}';

const target = ${name}.named('${name}');

unitTest('${name} is a declared action', () => {
  expect(target.kind).toBe('action');
  expect(target.describe().name).toBe('${name}');
});

unitTest('${name} takes what its form posts and refuses the rest', async () => {
  await expect(target.input).toAcceptInput(${accepted});
  await expect(target.input).toRejectInput(${refused});
});
`;

/** An address and a password, posted at `createSession`, with the way back to where they were. */
const PASSWORD_FORM: SignInForm = {
  comment: `// Sign in: a native \`<form method="post">\` at the route \`createSession\` derives. Nothing here
// hydrates, so the browser's own form handling is the client, and the page ships no script.`,
  imports: ["import { Button, Field, Input } from '@ultimat3/ui';"],
  localImports: ["import { NEXT_PARAM, nextPath } from '../sign-in-flow';"],
  props: true,
  body: `      <form method="post" action={derivePath('createSession').path}>
        <input type="hidden" name={NEXT_PARAM} value={nextPath(props.query?.[NEXT_PARAM])} />
        <Field label={t('app.auth.signIn.email')} required>
          {(control) => <Input {...control} name="email" type="email" autocomplete="username" />}
        </Field>
        <Field label={t('app.auth.signIn.password')} required>
          {(control) => (
            <Input {...control} name="password" type="password" autocomplete="current-password" />
          )}
        </Field>
        <Button type="submit">{t('app.auth.signIn.submit')}</Button>
      </form>`,
};

const CATALOG: Readonly<Record<string, string>> = {
  ...SIGN_IN_CATALOG,
  'app.auth.signIn.email': 'Email',
  'app.auth.signIn.password': 'Password',
  'app.auth.signIn.submit': 'Sign in',
  'app.auth.secondFactor.title': 'Second factor',
  'app.auth.secondFactor.description': 'Enter the code from your authenticator app.',
  'app.auth.secondFactor.code': 'Code',
  'app.auth.secondFactor.submit': 'Continue',
};

/** The test's expectation that the page's form posts at `action`'s derived route. */
const POSTS_AT = (action: string): string => `\`action="\${derivePath('${action}').path}"\``;

export function passwordSignInFiles(options: SignInTemplateOptions): readonly GeneratedFile[] {
  const module = options.catalogModule;
  return [
    ...sharedSignInFiles(
      PASSWORD_SIGN_IN_ENV,
      'The master key seals the second-factor challenge between the two legs.',
    ),
    { path: `${AUTH_DIR}/sign-in-challenge.ts`, contents: challengeSource() },
    { path: `${AUTH_DIR}/sign-in-challenge.test.ts`, contents: challengeTest() },
    { path: `${AUTH_DIR}/actions/create-session.ts`, contents: createSessionSource() },
    {
      path: `${AUTH_DIR}/actions/create-session.test.ts`,
      contents: actionTest(
        'createSession',
        'create-session',
        "{ email: 'ada@example.com', password: 'a passphrase' }",
        "{ email: 'not an address', password: 'a passphrase' }",
      ),
    },
    { path: `${AUTH_DIR}/actions/confirm-session.ts`, contents: confirmSessionSource() },
    {
      path: `${AUTH_DIR}/actions/confirm-session.test.ts`,
      contents: actionTest('confirmSession', 'confirm-session', "{ code: '123456' }", '{}'),
    },
    { path: `${AUTH_DIR}/sign-in/page.tsx`, contents: signInPageSource(module, PASSWORD_FORM) },
    {
      path: `${AUTH_DIR}/sign-in/page.test.ts`,
      contents: signInPageTest(module, 'app.auth.signIn', POSTS_AT('createSession')),
    },
    { path: `${AUTH_DIR}/sign-in/second-factor/page.tsx`, contents: secondFactorSource(module) },
    {
      path: `${AUTH_DIR}/sign-in/second-factor/page.test.ts`,
      contents: signInPageTest(module, 'app.auth.secondFactor', POSTS_AT('confirmSession'), false),
    },
    ...options.locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogJson(CATALOG),
      merge: 'json' as const,
    })),
  ];
}
