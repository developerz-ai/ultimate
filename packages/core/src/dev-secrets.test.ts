// Single responsibility: pins the boot refusal of the shipped dev cursor secret outside a local
// environment — and that a process with NO environment counts as production, not development.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CURSOR_SECRET_FIX,
  CURSOR_SECRET_KEY,
  configureCursorSigning,
  currentSigningSecret,
  DEV_CURSOR_SECRET,
  resetCursorSigning,
  usesDevCursorSecret,
} from './cursor';
import {
  assertNoDevSecretsOutsideLocal,
  CursorSecretDevError,
  devSecretsRefused,
} from './dev-secrets';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const previous = process.env['ULTIMATE_CURSOR_SECRET'];
afterEach(() => {
  resetCursorSigning();
  if (previous === undefined) delete process.env['ULTIMATE_CURSOR_SECRET'];
  else process.env['ULTIMATE_CURSOR_SECRET'] = previous;
});

describe('assertNoDevSecretsOutsideLocal', () => {
  test('with no environment at all, the dev cursor secret is refused', () => {
    // `isLocal()`'s own fallback is `development`, so an unset env read as local and the shipped
    // key signed every cursor of a production pod that forgot ULTIMATE_ENV and NODE_ENV.
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    expect(codeOf(() => assertNoDevSecretsOutsideLocal({ env: {} }))).toBe('X_CURSOR_SECRET_DEV');
  });

  test.each(['production', 'staging'])('%s refuses the dev secret', (environment) => {
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    const run = () => assertNoDevSecretsOutsideLocal({ env: { ULTIMATE_ENV: environment } });
    expect(codeOf(run)).toBe('X_CURSOR_SECRET_DEV');
  });

  test.each(['development', 'test'])('%s accepts the dev secret', (environment) => {
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    expect(() => assertNoDevSecretsOutsideLocal({ env: { NODE_ENV: environment } })).not.toThrow();
  });

  test.each(['production', 'staging'])(
    '%s refuses an EMPTY secret as the unset one it is',
    (environment) => {
      // `ULTIMATE_CURSOR_SECRET=` in a compose file or a chart with a blank value: `??` kept the
      // empty string, every cursor was signed under the key '' and the boot check passed.
      process.env['ULTIMATE_CURSOR_SECRET'] = '';
      expect(usesDevCursorSecret()).toBe(true);
      const run = () => assertNoDevSecretsOutsideLocal({ env: { ULTIMATE_ENV: environment } });
      expect(codeOf(run)).toBe('X_CURSOR_SECRET_DEV');
    },
  );

  test('an empty configureCursorSigning value is unset too, and never an empty HMAC key', () => {
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    configureCursorSigning('');
    expect(usesDevCursorSecret()).toBe(true);
    expect(currentSigningSecret()).not.toBe('');
  });

  test('a real secret passes everywhere, from the env or from configureCursorSigning', () => {
    process.env['ULTIMATE_CURSOR_SECRET'] = 'a-real-secret';
    expect(() => assertNoDevSecretsOutsideLocal({ env: {} })).not.toThrow();
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    configureCursorSigning('configured-at-boot');
    expect(() => assertNoDevSecretsOutsideLocal({ env: {} })).not.toThrow();
  });

  test('the refusal names the variable and never a secret value', () => {
    delete process.env['ULTIMATE_CURSOR_SECRET'];
    try {
      assertNoDevSecretsOutsideLocal({ env: { ULTIMATE_ENV: 'production' } });
      expect.unreachable();
    } catch (error) {
      const text = String((error as Error).message);
      expect(text).toContain('ULTIMATE_CURSOR_SECRET');
      expect(text).not.toContain('ultimate-dev-cursor-secret');
    }
  });
});

// One rule for "does this environment refuse a shipped dev secret": the boot's, which FAILS
// CLOSED — so `x env check` and `x doctor` ask it too, rather than a reading that defaults to
// development and calls an environment green that the boot refuses (#679 review).
describe('devSecretsRefused', () => {
  test('a process that names no environment is refused, as the boot refuses it', () => {
    expect(devSecretsRefused({ env: {} })).toBe(true);
  });

  test('staging and production are refused; development and test are not', () => {
    expect(devSecretsRefused({ env: { ULTIMATE_ENV: 'staging' } })).toBe(true);
    expect(devSecretsRefused({ env: { NODE_ENV: 'production' } })).toBe(true);
    expect(devSecretsRefused({ env: { ULTIMATE_ENV: 'development' } })).toBe(false);
    expect(devSecretsRefused({ env: { NODE_ENV: 'test' } })).toBe(false);
  });
});

describe('usesDevCursorSecret over a table', () => {
  test('unset, empty and the published key all sign with the dev key', () => {
    expect(usesDevCursorSecret({ env: {} })).toBe(true);
    expect(usesDevCursorSecret({ env: { ULTIMATE_CURSOR_SECRET: '' } })).toBe(true);
    expect(usesDevCursorSecret({ env: { ULTIMATE_CURSOR_SECRET: DEV_CURSOR_SECRET } })).toBe(true);
    expect(usesDevCursorSecret({ env: { ULTIMATE_CURSOR_SECRET: 'k'.repeat(64) } })).toBe(false);
  });
});

// One code, one fix: `x doctor` and `x env check` print the same line for X_CURSOR_SECRET_DEV
// (`@ultimat3/cli`'s `framework-env.ts` reads `CURSOR_SECRET_FIX`), and the boot's refusal was
// the odd one out with `x secrets set …` (#679 review).
describe('the boot refusal names the key and the one fix', () => {
  test('its fix is CURSOR_SECRET_FIX, and both are built from CURSOR_SECRET_KEY', () => {
    const error = new CursorSecretDevError();
    expect(error.fix).toBe(CURSOR_SECRET_FIX);
    expect(CURSOR_SECRET_FIX).toBe(`export ${CURSOR_SECRET_KEY}="$(openssl rand -hex 32)"`);
    expect(error.cause).toContain(CURSOR_SECRET_KEY);
  });
});
