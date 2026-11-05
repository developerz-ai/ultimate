// The tests `x g sign-in` writes for its actions, as text: each installs the migrated database and
// RUNS its handler inside a request, asserting the paths a person takes. Whether they pass is a
// scaffold's run (`scripts/scaffold-first-run.ts`, then the gate's coverage floor).

import { describe, expect, test } from 'bun:test';
import { confirmSessionTest, createSessionTest, destroySessionTest } from './sign-in-action-tests';

const sources = {
  createSession: createSessionTest(),
  confirmSession: confirmSessionTest(),
  destroySession: destroySessionTest(),
};

describe('unit · the sign-in action tests', () => {
  test('each installs the app’s migrated database under db(), and takes it back', () => {
    for (const source of Object.values(sources)) {
      expect(source).toContain(
        'const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));',
      );
      expect(source).toContain('setDbClient(await workerDatabase());');
      expect(source).toContain('afterAll(() => setDbClient(undefined));');
    }
  });

  test('each runs its handler inside a request context, never just its declaration', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source).toContain(`const target = ${name}.named('${name}');`);
      expect(source).toContain('const ctx = asCtx(request);');
      expect(source).toMatch(/await runWithContext\(ctx, \(\) => target\(.*, \{ ctx \}\)\);/);
    }
  });

  test('sign-in: a wrong password refused, a right one a cookie, a second factor a challenge', () => {
    const source = sources.createSession;
    expect(source).toContain("expect(refused).toBeUltimateError('X_UNAUTHENTICATED');");
    expect(source).toContain(
      'expect(sets(request, appAuth().sessions.policy.cookieName)).toBe(true);',
    );
    expect(source).toContain('expect(sets(request, MFA_CHALLENGE_COOKIE)).toBe(true);');
    expect(source).toContain(
      'expect(request.redirect).toEqual({ location: AFTER_SIGN_IN, status: 303 });',
    );
  });

  test('second factor: refused with no challenge held, signed in with one and the right code', () => {
    const source = sources.confirmSession;
    expect(source).toContain("const refused = await post({ code: '123456' })");
    expect(source).toContain('const code = totpCode(secret, totpStep(new Date()));');
    expect(source).toContain('MFA_CHALLENGE_COOKIE}=;');
  });

  test('sign-out: a live session revoked, and none still lands at the home page', () => {
    const source = sources.destroySession;
    expect(source).toContain("expect(output).toEqual({ ok: true, next: '/', revoked: true });");
    expect(source).toContain("expect(request.redirect).toEqual({ location: '/', status: 303 });");
  });
});
