// The password shape keeps `?next=` across the second factor: the first leg's redirect carries it,
// and the second-factor form posts it back, so `confirmSession` lands where the person was going.
// That the bytes compile, lint and pass their own tests is `generate-sign-in.contract.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import { passwordSignInFiles } from './sign-in-password';
import { AUTH_DIR } from './sign-in-shared';

const files = passwordSignInFiles({ locales: ['en'] });

const source = (path: string): string => {
  const file = files.find((candidate) => candidate.path === `${AUTH_DIR}/${path}`);
  if (file === undefined || typeof file.contents !== 'string') {
    return expect.unreachable(`${path} is written as text`);
  }
  return file.contents;
};

describe('unit · password sign-in keeps ?next= across the second factor', () => {
  test('createSession sends a challenged sign-in to the second factor with its next path', () => {
    const action = source('actions/create-session.ts');
    expect(action).toContain('SECOND_FACTOR_PATH}?');
    expect(action).toContain('NEXT_PARAM}=');
    expect(action).toContain('encodeURIComponent(nextPath(next))');
    expect(action).toContain('next: then, secondFactor: true');
    // The one redirect path: `native:` answers the browser from `next`; nothing sniffs `accept`.
    expect(action).toContain('native: { success: (output) => output.next },');
    expect(action).not.toContain('setRedirect');
  });

  test('the second-factor form posts the next path back to confirmSession', () => {
    const page = source('sign-in/second-factor/page.tsx');
    expect(page).toContain("import { NEXT_PARAM, nextPath } from '../../sign-in-flow';");
    expect(page).toContain('export function Page(props: SecondFactorProps)');
    expect(page).toContain(
      '<input type="hidden" name={NEXT_PARAM} value={nextPath(props.query?.[NEXT_PARAM])} />',
    );
  });

  // One MFA challenge cookie (auth's `__Host-x_mfa`): the scaffold neither names one of its own
  // nor re-implements how a challenge is read off `X_MFA_REQUIRED`.
  test('the challenge is held, read and dropped through auth, in auth’s own cookie', () => {
    const challenge = source('sign-in-challenge.ts');
    expect(challenge).toContain("headers.append('set-cookie', mfaChallengeCookie(challenge))");
    expect(challenge).toContain('readMfaChallenge({ headers: useRequestHeaders() })');
    expect(challenge).toContain("headers.append('set-cookie', clearMfaChallengeCookie())");
    expect(source('actions/create-session.ts')).toContain('mfaChallengeOf(error)');
    for (const file of files) {
      if (typeof file.contents !== 'string') continue;
      for (const own of ['x_mfa_challenge', '__Host-x_mfa', "error.meta?.['challenge']"]) {
        expect(`${file.path}: ${file.contents.includes(own)}`).toBe(`${file.path}: false`);
      }
      expect(`${file.path}: ${/\bsetCookie\(|\bdeleteCookie\(/.test(file.contents)}`).toBe(
        `${file.path}: false`,
      );
    }
  });
});
