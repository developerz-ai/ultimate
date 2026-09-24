// unit — the two environment rules only production enforces: an origin that is really set, and a
// captcha verifier that is really a verifier (or a warning saying it is not).

import { describe, expect, test } from 'bun:test';
import type { Environment } from '@ultimat3/core';
import { checkProductionEnv } from './production-env';

interface Logged {
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const run = (
  environment: Environment,
  values: { readonly APP_URL?: string; readonly HCAPTCHA_SECRET?: string },
): readonly Logged[] => {
  const logged: Logged[] = [];
  checkProductionEnv(values, environment, {
    warn: (message, fields) => logged.push({ message, fields: fields ?? {} }),
  });
  return logged;
};

describe('APP_URL', () => {
  test('production without one refuses to boot, naming the key', () => {
    try {
      run('production', { HCAPTCHA_SECRET: 's' });
      expect.unreachable('an unset APP_URL booted in production');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_ENV_MISSING' });
      expect(String((error as { fix: unknown }).fix)).toContain('APP_URL=');
    }
  });

  test('a blank one is unset too — an empty secret mount is not an origin', () => {
    expect(() => run('production', { APP_URL: ' ', HCAPTCHA_SECRET: 's' })).toThrow(/APP_URL/);
  });

  test('production with one boots, and nothing else asks for it', () => {
    expect(run('production', { APP_URL: 'https://social.example', HCAPTCHA_SECRET: 's' })).toEqual(
      [],
    );
    for (const environment of ['development', 'test', 'staging'] as const) {
      expect(() => run(environment, { HCAPTCHA_SECRET: 's' })).not.toThrow();
    }
  });
});

describe('HCAPTCHA_SECRET', () => {
  test('outside local, the null verifier is a warning at boot — never a refusal', () => {
    for (const environment of ['staging', 'production'] as const) {
      const logged = run(environment, { APP_URL: 'https://social.example' });
      expect(logged.map((entry) => entry.message)).toEqual(['auth.captcha.unverified']);
      expect(logged[0]?.fields).toMatchObject({ environment, key: 'HCAPTCHA_SECRET' });
    }
  });

  test('locally the null verifier is the design, so it says nothing', () => {
    for (const environment of ['development', 'test'] as const) {
      expect(run(environment, {})).toEqual([]);
    }
  });

  test('a set secret says nothing anywhere', () => {
    expect(run('staging', { HCAPTCHA_SECRET: 'x' })).toEqual([]);
  });
});
