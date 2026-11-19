// `x g sign-in --oidc`'s second leg. An MFA-enrolled user's callback cannot finish inside
// `oauthLogin`: it 303s to `mfaPath` with the challenge sealed in auth's own HttpOnly cookie, so the
// scaffold passes that path and ships the page and the action behind it (auth README, MFA).

import type { GeneratedFile } from './naming';
import { confirmSessionTest } from './sign-in-action-tests';
import { challengeSource, challengeTest } from './sign-in-challenge';
import { secondFactorSource, signInPageTest } from './sign-in-pages';
import { confirmSessionSource, POSTS_AT } from './sign-in-password';
import { AUTH_DIR } from './sign-in-shared';

/** The `import` and the option `oidc.ts` gains: the callback's way to the second-factor page. */
export const OIDC_MFA_IMPORT = "import { SECOND_FACTOR_PATH } from './sign-in-challenge';";
export const OIDC_MFA_OPTION = 'mfaPath: SECOND_FACTOR_PATH,';

export function oidcSecondFactorFiles(module: string | undefined): readonly GeneratedFile[] {
  return [
    { path: `${AUTH_DIR}/sign-in-challenge.ts`, contents: challengeSource('oidc') },
    { path: `${AUTH_DIR}/sign-in-challenge.test.ts`, contents: challengeTest() },
    { path: `${AUTH_DIR}/actions/confirm-session.ts`, contents: confirmSessionSource() },
    {
      path: `${AUTH_DIR}/actions/confirm-session.test.ts`,
      contents: confirmSessionTest(),
    },
    { path: `${AUTH_DIR}/sign-in/second-factor/page.tsx`, contents: secondFactorSource(module) },
    {
      path: `${AUTH_DIR}/sign-in/second-factor/page.test.ts`,
      contents: signInPageTest(module, 'app.auth.secondFactor', POSTS_AT('confirmSession'), false),
    },
  ];
}
