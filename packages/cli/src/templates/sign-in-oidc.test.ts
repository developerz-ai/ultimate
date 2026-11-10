// `x g sign-in --oidc`'s files against @ultimat3/auth's own path: the generated tests pin the start
// leg as a literal, so a literal that drifts from `oauthStartPath` ships a scaffold whose first gate
// is red (`/auth/oauth/<id>` after the routes moved to `/auth/sso/<id>`, breaking change #52).

import { describe, expect, test } from 'bun:test';
import { OAUTH_BASE_PATH, oauthStartPath } from '@ultimat3/auth';
import { oidcSignInFiles } from './sign-in-oidc';

const files = new Map(
  oidcSignInFiles('corp-sso', { locales: ['en'] }).map((file) => [
    file.path,
    String(file.contents),
  ]),
);
const ofName = (suffix: string): string =>
  [...files.entries()].find(([path]) => path.endsWith(suffix))?.[1] ?? '';

describe('unit · x g sign-in --oidc spells the start leg as @ultimat3/auth does', () => {
  test('the generated oidc test pins the path oauthStartPath answers', () => {
    expect(ofName('/oidc.test.ts')).toContain(`toBe('${oauthStartPath('corp-sso')}')`);
  });

  test('the generated page test looks for a link to that path', () => {
    expect(ofName('/sign-in/page.test.ts')).toContain(`href="${oauthStartPath('corp-sso')}"`);
  });

  test('no generated file names a path outside the auth base', () => {
    for (const [path, contents] of files) {
      for (const found of contents.match(/\/auth\/[a-z]+\/corp-sso/g) ?? []) {
        expect(`${path}: ${found}`).toBe(`${path}: ${OAUTH_BASE_PATH}/corp-sso`);
      }
    }
  });
});
