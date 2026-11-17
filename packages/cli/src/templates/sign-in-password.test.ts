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
    expect(action).toContain('next: landAt(then), secondFactor: true');
    expect(action).not.toContain('landAt(SECOND_FACTOR_PATH)');
  });

  test('the second-factor form posts the next path back to confirmSession', () => {
    const page = source('sign-in/second-factor/page.tsx');
    expect(page).toContain("import { NEXT_PARAM, nextPath } from '../../sign-in-flow';");
    expect(page).toContain('export function Page(props: SecondFactorProps)');
    expect(page).toContain(
      '<input type="hidden" name={NEXT_PARAM} value={nextPath(props.query?.[NEXT_PARAM])} />',
    );
  });
});
