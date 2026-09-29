// The `islands` section: the default, the overlay merge, and the refusal `defineConfig` raises.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

describe('islands — default, merge and refusal', () => {
  test('off by default: every island is its own self-contained chunk', () => {
    expect(defineConfig({ name: 'app' }).islands).toEqual({ sharedChunks: false });
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
});
