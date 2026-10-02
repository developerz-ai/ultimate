// Single responsibility: pins the boot refusal of the shipped dev cursor secret outside a local
// environment — and that a process with NO environment counts as production, not development.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  configureCursorSigning,
  currentSigningSecret,
  resetCursorSigning,
  usesDevCursorSecret,
} from './cursor';
import { assertNoDevSecretsOutsideLocal } from './dev-secrets';

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
