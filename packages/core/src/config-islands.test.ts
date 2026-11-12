// The `islands` section: the default, the overlay merge, and the refusal `defineConfig` raises.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

describe('islands — default, merge and refusal', () => {
  test('off by default: every island is its own self-contained chunk', () => {
    expect(defineConfig({ name: 'app' }).islands).toEqual({
      sharedChunks: false,
      vendorSolid: false,
    });
  });

  test('the last layer that said it wins; one that said nothing keeps it', () => {
    const config = defineConfig({ name: 'app', islands: { sharedChunks: true } }, { islands: {} });
    expect(config.islands.sharedChunks).toBe(true);
  });

  test('a value that is not a boolean is X_CONFIG_INVALID, naming the key', () => {
    let cause = '';
    try {
      defineConfig({ name: 'app', islands: { sharedChunks: 'yes' as unknown as boolean } });
    } catch (error) {
      cause = isUltimateError(error) ? error.cause : `not an UltimateError: ${String(error)}`;
    }
    expect(cause).toContain('islands.sharedChunks must be true or false, not');
  });

  test('vendorSolid: off by default, merged per layer, refused when not a boolean', () => {
    const on = defineConfig({ name: 'app', islands: { vendorSolid: true } }, { islands: {} });
    expect(on.islands).toEqual({ sharedChunks: false, vendorSolid: true });
    const off = defineConfig(
      { name: 'app', islands: { vendorSolid: true } },
      { islands: { vendorSolid: false } },
    );
    expect(off.islands.vendorSolid).toBe(false);
    let cause = '';
    try {
      defineConfig({ name: 'app', islands: { vendorSolid: 1 as unknown as boolean } });
    } catch (error) {
      cause = isUltimateError(error) ? error.cause : `not an UltimateError: ${String(error)}`;
    }
    expect(cause).toContain('islands.vendorSolid must be true or false, not');
  });
});
