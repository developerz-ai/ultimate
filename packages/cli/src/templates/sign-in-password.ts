// `x g sign-in --password`: an address and a password over `login()`, the second leg over
// `completeMfa()`, and the two native-form pages that post at them. No island: the browser's own
// form handling is the client, so the pages ship 0 bytes of script.

import { catalogJson } from './catalog-json';
import { catalogPath } from './locales';
import type { GeneratedFile } from './naming';
import { confirmSessionTest, createSessionTest } from './sign-in-action-tests';
import { challengeSource, challengeTest } from './sign-in-challenge';
import {
  SIGN_IN_CATALOG,
  type SignInForm,
  type SignInTemplateOptions,
  secondFactorSource,
  signInPageSource,
  signInPageTest,
} from './sign-in-pages';
import { AUTH_DIR, sharedSignInFiles } from './sign-in-shared';

/** The master key seals the second-factor challenge between the two legs. */
export const PASSWORD_SIGN_IN_ENV: readonly string[] = ['ULTIMATE_SECRETS_KEY'];

const createSessionSource =
  (): string => `// Sign in with an address and a password. \`login()\` is the whole check — the hash, the lockout and
// one indistinguishable \`X_UNAUTHENTICATED\` for every way a credential is wrong. A second factor
// still owed stops here with the sealed challenge held for the next page.
import { action, t } from '@ultimat3/action';
import { login, mfaChallengeOf } from '@ultimat3/auth';
import { useRequestContext } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { holdChallenge, SECOND_FACTOR_PATH } from '../sign-in-challenge';
import { NEXT_PARAM, nextPath } from '../sign-in-flow';

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
  // A browser's own form lands where the output says; fetch and the typed client read \`next\`.
  native: { success: (output) => output.next },
  async handle({ input }) {
    const request = useRequestContext('createSession');
    try {
      const signedIn = await login(appAuth(), {
        email: input.email,
        password: input.password,
        ip: request.ip,
      });
      request.headers.append('set-cookie', signedIn.cookie);
      return { ok: true, next: nextPath(input[NEXT_PARAM]), secondFactor: false };
    } catch (error) {
      const challenge = mfaChallengeOf(error);
      if (challenge === null) throw error;
      holdChallenge(challenge);
      // The way on survives the second leg: its form posts \`next\` back to \`confirmSession\`.
      const next = input[NEXT_PARAM];
      const then =
        next === undefined
          ? SECOND_FACTOR_PATH
          : \`\${SECOND_FACTOR_PATH}?\${NEXT_PARAM}=\${encodeURIComponent(nextPath(next))}\`;
      return { ok: false, next: then, secondFactor: true };
    }
  },
});
`;

/** Both shapes' second leg: it reads the challenge through `../sign-in-challenge`, whoever held it. */
export const confirmSessionSource =
  (): string => `// The second leg: the six digits (or one recovery code) against the challenge the first leg held.
// \`completeMfa()\` meters the guess against the same lockout a password guess spends.
import { action, t } from '@ultimat3/action';
import { authUnauthenticated, completeMfa } from '@ultimat3/auth';
import { useRequestContext } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { dropChallenge, heldChallenge } from '../sign-in-challenge';
import { NEXT_PARAM, nextPath } from '../sign-in-flow';

export const confirmSession = action({
  input: t.object({
    code: t.string.min(1).max(64),
    [NEXT_PARAM]: t.optional(t.string.max(2048)),
  }),
  output: t.object({ ok: t.boolean, next: t.string }),
  policy: allow('public'),
  mcp: { expose: false },
  // A browser's own form lands where the output says; fetch and the typed client read \`next\`.
  native: { success: (output) => output.next },
  async handle({ input }) {
    const request = useRequestContext('confirmSession');
    const challenge = heldChallenge();
    if (challenge === null) throw authUnauthenticated('POST confirmSession');
    const signedIn = await completeMfa(appAuth(), challenge, input.code, { ip: request.ip });
    dropChallenge();
    request.headers.append('set-cookie', signedIn.cookie);
    return { ok: true, next: nextPath(input[NEXT_PARAM]) };
  },
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

/** The second-factor page's copy, for whichever shape reaches it. */
export const SECOND_FACTOR_CATALOG: Readonly<Record<string, string>> = {
  'app.auth.secondFactor.title': 'Second factor',
  'app.auth.secondFactor.description': 'Enter the code from your authenticator app.',
  'app.auth.secondFactor.code': 'Code',
  'app.auth.secondFactor.submit': 'Continue',
};

const CATALOG: Readonly<Record<string, string>> = {
  ...SIGN_IN_CATALOG,
  'app.auth.signIn.email': 'Email',
  'app.auth.signIn.password': 'Password',
  'app.auth.signIn.submit': 'Sign in',
  ...SECOND_FACTOR_CATALOG,
};

/** The test's expectation that the page's form posts at `action`'s derived route. */
export const POSTS_AT = (action: string): string => `\`action="\${derivePath('${action}').path}"\``;

export function passwordSignInFiles(options: SignInTemplateOptions): readonly GeneratedFile[] {
  const module = options.catalogModule;
  return [
    ...sharedSignInFiles(
      PASSWORD_SIGN_IN_ENV,
      'The master key seals the second-factor challenge between the two legs.',
    ),
    { path: `${AUTH_DIR}/sign-in-challenge.ts`, contents: challengeSource('password') },
    { path: `${AUTH_DIR}/sign-in-challenge.test.ts`, contents: challengeTest() },
    { path: `${AUTH_DIR}/actions/create-session.ts`, contents: createSessionSource() },
    {
      path: `${AUTH_DIR}/actions/create-session.test.ts`,
      contents: createSessionTest(),
    },
    { path: `${AUTH_DIR}/actions/confirm-session.ts`, contents: confirmSessionSource() },
    {
      path: `${AUTH_DIR}/actions/confirm-session.test.ts`,
      contents: confirmSessionTest(),
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
