// `x dev` never named its own environment: `tryResolveEnvironment({ env })` answers
// `DEFAULT_ENVIRONMENT` ('development') only by DEFAULT when neither `ULTIMATE_ENV` nor
// `NODE_ENV` is set, which is exactly why a scaffolded app's `apps/web/app/auth/dev-actor.ts`
// failed OPEN — nothing told a bare `x dev` apart from a process that named no environment at
// all. This pins the fix: the pure decision (`needsDevEnvironmentDeclaration`) and the one-liner
// side effect it gates (`declareDevEnvironment`), split out of `devCommand.run` in `cmd-dev.ts`
// for exactly this reason — a real assertion on `process.env` that does not have to boot the
// whole app (embedded Postgres, storage, the dev dashboard) to make it.
//
// The wiring — that `run` calls `declareDevEnvironment(ctx.env)` before `startDev` imports a
// single app module — is a one-line call site read at the definition, not re-proven by booting
// here; `cmd-dev.test.ts`'s own end-to-end suite (and `scripts/scaffold-*` for a fresh app) is
// what would catch a real app answering the wrong environment.

import { afterEach, describe, expect, test } from 'bun:test';
import { declareDevEnvironment, needsDevEnvironmentDeclaration } from './dev-environment';

describe('unit · needsDevEnvironmentDeclaration', () => {
  test('neither key set is exactly the case that needs a declaration', () => {
    expect(needsDevEnvironmentDeclaration({})).toBe(true);
    expect(needsDevEnvironmentDeclaration({ ULTIMATE_ENV: undefined, NODE_ENV: undefined })).toBe(
      true,
    );
  });

  test('ULTIMATE_ENV="" matches core\'s own reader — treated as unset', () => {
    expect(needsDevEnvironmentDeclaration({ ULTIMATE_ENV: '' })).toBe(true);
    expect(needsDevEnvironmentDeclaration({ ULTIMATE_ENV: '', NODE_ENV: '' })).toBe(true);
  });

  test('a non-empty ULTIMATE_ENV is already declared, whatever its value', () => {
    expect(needsDevEnvironmentDeclaration({ ULTIMATE_ENV: 'staging' })).toBe(false);
    expect(needsDevEnvironmentDeclaration({ ULTIMATE_ENV: 'not-a-real-environment' })).toBe(false);
  });

  // Named because it is the one value most likely to reach `x dev` from a real shell: `ci` is
  // not a member of `Environment`, so `resolveEnvironment` would fall through it to
  // `DEFAULT_ENVIRONMENT` exactly as an unset key does — but an operator set SOMETHING, and this
  // function's contract is "declare only when NEITHER key was set", not "declare whenever the
  // result would be development anyway".
  test('NODE_ENV=ci counts as already set, and gets no override', () => {
    expect(needsDevEnvironmentDeclaration({ NODE_ENV: 'ci' })).toBe(false);
  });

  test('a real NODE_ENV value other than ci is the same case, already set', () => {
    expect(needsDevEnvironmentDeclaration({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('unit · declareDevEnvironment', () => {
  const prior = { ULTIMATE_ENV: process.env['ULTIMATE_ENV'], NODE_ENV: process.env['NODE_ENV'] };

  afterEach(() => {
    for (const key of ['ULTIMATE_ENV', 'NODE_ENV'] as const) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('neither key set: writes ULTIMATE_ENV=development onto the real process.env', () => {
    delete process.env['ULTIMATE_ENV'];
    delete process.env['NODE_ENV'];
    // The exact call `x dev`'s `run` makes, and the exact fact that keeps a scaffolded app's
    // `dev-actor.ts` (once it moves to `fallback: 'production'`) IN `development` instead of
    // booting closed with no dev authenticator installed at all.
    declareDevEnvironment(process.env);
    expect(process.env['ULTIMATE_ENV']).toBe('development');
  });

  test('an explicit NODE_ENV is left untouched, and ULTIMATE_ENV stays unset', () => {
    delete process.env['ULTIMATE_ENV'];
    process.env['NODE_ENV'] = 'test';
    declareDevEnvironment(process.env);
    expect(process.env['ULTIMATE_ENV']).toBeUndefined();
    expect(process.env['NODE_ENV']).toBe('test');
  });

  test('an explicit ULTIMATE_ENV is left untouched', () => {
    process.env['ULTIMATE_ENV'] = 'test';
    delete process.env['NODE_ENV'];
    declareDevEnvironment(process.env);
    expect(process.env['ULTIMATE_ENV']).toBe('test');
  });

  test('an empty-string ULTIMATE_ENV is overwritten, matching core\'s own "unset" reading', () => {
    process.env['ULTIMATE_ENV'] = '';
    delete process.env['NODE_ENV'];
    declareDevEnvironment(process.env);
    expect(process.env['ULTIMATE_ENV']).toBe('development');
  });
});
