// `x g sign-in --oidc`'s second leg. An MFA-enrolled user's callback cannot finish inside
// `oauthLogin`: it 303s to `mfaPath` with the challenge sealed in auth's own HttpOnly cookie, so the
// scaffold passes that path and ships the page and the action behind it (auth README, MFA).

import type { GeneratedFile } from './naming';
import { type ChallengeAccess, confirmSessionTest } from './sign-in-action-tests';
import { secondFactorSource, signInPageTest } from './sign-in-pages';
import { confirmSessionSource, POSTS_AT } from './sign-in-password';
import { AUTH_DIR, SIGN_IN_PATH } from './sign-in-shared';

const challengeSource =
  (): string => `// The second-factor challenge between the provider's callback and the code. \`oauthLogin({ mfaPath })\`
// sends an enrolled user to SECOND_FACTOR_PATH with it sealed in auth's own HttpOnly cookie — never
// a URL a log keeps — and \`confirmSession\` reads it back through here.
import { clearMfaChallengeCookie, readMfaChallenge } from '@ultimat3/auth';
import { useRequestContext, useRequestHeaders } from '@ultimat3/http';

/** The \`mfaPath\` \`oidc.ts\` hands \`oauthLogin\`, and the page that posts the code. */
export const SECOND_FACTOR_PATH = '${SIGN_IN_PATH}/second-factor';

export const heldChallenge = (): string | null => {
  const value = readMfaChallenge({ headers: useRequestHeaders() });
  return value === null || value === '' ? null : value;
};

/** Auth's own clearing line, relayed as it is: the cookie's name and attributes are auth's. */
export const dropChallenge = (): void => {
  useRequestContext('dropChallenge').headers.append('set-cookie', clearMfaChallengeCookie());
};
`;

const challengeTest =
  (): string => `// The path the callback redirects to is the page this app serves the second-factor form at.
import { expect, unitTest } from '@ultimat3/testing';
import { SECOND_FACTOR_PATH } from './sign-in-challenge';

unitTest('the second leg lives under the sign-in page', () => {
  expect(SECOND_FACTOR_PATH).toBe('${SIGN_IN_PATH}/second-factor');
});
`;

/** The confirm test reads the challenge off `login()`'s refusal and names auth's own cookie. */
const OIDC_CHALLENGE: ChallengeAccess = {
  authImports: ['clearMfaChallengeCookie'],
  imports: [],
  prelude: `
/** The cookie the callback seals the challenge in, read off the line that clears it. */
const MFA_CHALLENGE_COOKIE = clearMfaChallengeCookie().split('=')[0] ?? '';

/** The sealed challenge an \`X_MFA_REQUIRED\` carries, or \`null\` for any other throw. */
const challengeOf = (error: unknown): string | null => {
  const meta = (error as { meta?: Readonly<Record<string, unknown>> } | null)?.meta;
  const challenge = meta?.['challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
};
`,
};

/** The `import` and the option `oidc.ts` gains: the callback's way to the second-factor page. */
export const OIDC_MFA_IMPORT = "import { SECOND_FACTOR_PATH } from './sign-in-challenge';";
export const OIDC_MFA_OPTION = 'mfaPath: SECOND_FACTOR_PATH,';

export function oidcSecondFactorFiles(module: string | undefined): readonly GeneratedFile[] {
  return [
    { path: `${AUTH_DIR}/sign-in-challenge.ts`, contents: challengeSource() },
    { path: `${AUTH_DIR}/sign-in-challenge.test.ts`, contents: challengeTest() },
    { path: `${AUTH_DIR}/actions/confirm-session.ts`, contents: confirmSessionSource() },
    {
      path: `${AUTH_DIR}/actions/confirm-session.test.ts`,
      contents: confirmSessionTest(OIDC_CHALLENGE),
    },
    { path: `${AUTH_DIR}/sign-in/second-factor/page.tsx`, contents: secondFactorSource(module) },
    {
      path: `${AUTH_DIR}/sign-in/second-factor/page.test.ts`,
      contents: signInPageTest(module, 'app.auth.secondFactor', POSTS_AT('confirmSession'), false),
    },
  ];
}
