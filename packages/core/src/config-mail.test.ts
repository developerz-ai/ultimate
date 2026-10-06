// The `mail` section: the default, the overlay merge, `true` as the default cap, and the refusals
// `defineConfig` raises before a driver is ever selected.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const causeOf = (call: () => unknown): string => {
  try {
    call();
  } catch (error) {
    return isUltimateError(error) ? error.cause : 'not an UltimateError';
  }
  return expect.unreachable('defineConfig accepted it');
};

describe('mail — default, merge and refusal', () => {
  test('off by default: no MIME is retained', () => {
    expect(defineConfig({ name: 'app' }).mail).toEqual({ retainMime: false });
  });

  test('true is the default cap; an object carries its own', () => {
    expect(defineConfig({ name: 'app', mail: { retainMime: true } }).mail.retainMime).toEqual({
      maxBytes: undefined,
    });
    expect(
      defineConfig({ name: 'app', mail: { retainMime: { maxBytes: 1024 } } }).mail.retainMime,
    ).toEqual({ maxBytes: 1024 });
  });

  test('the last layer that said it wins; one that said nothing keeps it', () => {
    const on = defineConfig({ name: 'app', mail: { retainMime: true } }, { mail: {} });
    expect(on.mail.retainMime).toEqual({ maxBytes: undefined });
    const off = defineConfig(
      { name: 'app', mail: { retainMime: true } },
      { mail: { retainMime: false } },
    );
    expect(off.mail.retainMime).toBe(false);
  });

  test('a cap that is not a whole number of bytes above 0 is X_CONFIG_INVALID, naming the key', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      expect(
        causeOf(() => defineConfig({ name: 'app', mail: { retainMime: { maxBytes } } })),
      ).toContain('mail.retainMime.maxBytes must be a whole number of bytes above 0');
    }
  });

  test('a value that is neither a boolean nor an object is refused, and so is a null section', () => {
    expect(
      causeOf(() =>
        defineConfig({ name: 'app', mail: { retainMime: 'yes' as unknown as boolean } }),
      ),
    ).toContain('mail.retainMime must be true, false or { maxBytes }');
    // A list is an object to `typeof`: read as one it became `{ maxBytes: undefined }`, retention on.
    expect(
      causeOf(() => defineConfig({ name: 'app', mail: { retainMime: [] as unknown as boolean } })),
    ).toContain('mail.retainMime must be true, false or { maxBytes }');
    expect(
      causeOf(() => defineConfig({ name: 'app', mail: null as unknown as { retainMime: true } })),
    ).toContain('mail must be an object');
  });
});
