// `sign-in-challenge.ts` as both `x g sign-in` shapes write it: the second-factor challenge rides
// auth's ONE cookie (`__Host-x_mfa`), written, read and cleared through `@ultimat3/auth`. The
// password shape also holds it (its own first leg); OIDC's is held by `oauthLogin({ mfaPath })`.

import { SIGN_IN_PATH } from './sign-in-shared';

const HEADER: Readonly<Record<'password' | 'oidc', string>> = {
  password: `// The second-factor challenge between the two legs: a sealed, five-minute credential \`login()\`
// hands back inside \`X_MFA_REQUIRED\`, carried in auth's own HttpOnly cookie — never a URL a log
// keeps — and read back by \`confirmSession\` through here.`,
  oidc: `// The second-factor challenge between the provider's callback and the code. \`oauthLogin({ mfaPath })\`
// sends an enrolled user to SECOND_FACTOR_PATH with it sealed in auth's own HttpOnly cookie — never
// a URL a log keeps — and \`confirmSession\` reads it back through here.`,
};

const PATH_DOC: Readonly<Record<'password' | 'oidc', string>> = {
  password:
    '/** Where `createSession` sends a person who owes a code, and the page that posts it. */',
  oidc: '/** The `mfaPath` `oidc.ts` hands `oauthLogin`, and the page that posts the code. */',
};

const HOLD = `
/** Auth's own line: the cookie a built-in callback sets, living as long as the challenge. */
export const holdChallenge = (challenge: string): void => {
  useRequestContext('holdChallenge').headers.append('set-cookie', mfaChallengeCookie(challenge));
};
`;

export const challengeSource = (shape: 'password' | 'oidc'): string => {
  const names = [
    'clearMfaChallengeCookie',
    ...(shape === 'password' ? ['mfaChallengeCookie'] : []),
    'readMfaChallenge',
  ];
  return `${HEADER[shape]}
import { ${names.join(', ')} } from '@ultimat3/auth';
import { useRequestContext, useRequestHeaders } from '@ultimat3/http';

${PATH_DOC[shape]}
export const SECOND_FACTOR_PATH = '${SIGN_IN_PATH}/second-factor';
${shape === 'password' ? HOLD : ''}
export const heldChallenge = (): string | null => {
  const value = readMfaChallenge({ headers: useRequestHeaders() });
  return value === null || value === '' ? null : value;
};

/** Auth's own clearing line, relayed as it is: the cookie's name and attributes are auth's. */
export const dropChallenge = (): void => {
  useRequestContext('dropChallenge').headers.append('set-cookie', clearMfaChallengeCookie());
};
`;
};

export const challengeTest =
  (): string => `// The path the second leg lives at is the page this app serves the second-factor form at.
import { expect, unitTest } from '@ultimat3/testing';
import { SECOND_FACTOR_PATH } from './sign-in-challenge';

unitTest('the second leg lives under the sign-in page', () => {
  expect(SECOND_FACTOR_PATH).toBe('${SIGN_IN_PATH}/second-factor');
});
`;
