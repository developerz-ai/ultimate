// A container role whose app did not load whole refuses to serve. The boot used to log
// "ultimate app module failed to load" and start anyway: a module that threw on import registered
// none of its routes, actions, policies or jobs, and the pod answered healthy without them — a
// sign-in guard's own refusal included.

import { describe, expect, test } from 'bun:test';
import type { Finding } from './output';
import { refuseHalfLoadedApp } from './serve-boot';

const finding = (at: string, code: string): Finding => ({
  code,
  cause: `${at} threw on import`,
  fix: 'x manifest --json',
  at,
});

describe('unit · the container boot serves a whole app or none', () => {
  test('one module that failed to load stops the role, naming each module and its code', () => {
    let refused: unknown;
    try {
      refuseHalfLoadedApp('web', [
        finding('apps/web/app/auth/sign-in-guard.ts', 'X_AUTH_SIGN_IN_UNCONFIGURED'),
        finding('apps/web/app/post/policy.ts', 'X_CONFIG_INVALID'),
      ]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: 'X_APP_MODULE_LOAD_FAILED',
      meta: {
        role: 'web',
        modules: ['apps/web/app/auth/sign-in-guard.ts', 'apps/web/app/post/policy.ts'],
      },
    });
    const cause = (refused as { cause: string }).cause;
    expect(cause).toContain('apps/web/app/auth/sign-in-guard.ts (X_AUTH_SIGN_IN_UNCONFIGURED)');
    expect(cause).toContain('apps/web/app/post/policy.ts (X_CONFIG_INVALID)');
  });

  test('every role refuses, not only the one that serves pages', () => {
    for (const role of ['web', 'sync', 'worker', 'scheduler', 'replicator'] as const) {
      expect(() => refuseHalfLoadedApp(role, [finding('apps/web/a.ts', 'X_X')])).toThrow();
    }
  });

  test('an app that loaded whole starts', () => {
    expect(() => refuseHalfLoadedApp('web', [])).not.toThrow();
  });
});
