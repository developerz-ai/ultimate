// The `outbound` section: no proxy by default, merged by the last layer that said each key, and a
// proxy `fetch` cannot tunnel through refused at config time — without echoing its credential.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { OUTBOUND_DEFAULTS } from './config-outbound';
import { isUltimateError } from './errors';

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error)
      ? `${error.code} ${error.cause} ${error.fix} ${JSON.stringify(error.meta)}`
      : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('outbound — default, merge and refusal', () => {
  test('no proxy and no direct hosts until the app declares them', () => {
    expect(defineConfig({ name: 'app' }).outbound).toEqual({ proxy: undefined, direct: [] });
    expect(OUTBOUND_DEFAULTS).toEqual({ proxy: undefined, direct: [] });
  });

  test('each key is the last layer that said it; an overlay may own the direct list alone', () => {
    const config = defineConfig(
      { name: 'app', outbound: { proxy: 'http://egress.internal:3128', direct: ['a.internal'] } },
      { outbound: { direct: ['vault.internal'] } },
    );
    expect(config.outbound).toEqual({
      proxy: 'http://egress.internal:3128',
      direct: ['vault.internal'],
    });
  });

  test('a proxy that is not an http: or https: URL is refused, its credential never echoed', () => {
    const socks = refusal(() =>
      defineConfig({ name: 'app', outbound: { proxy: 'socks5://user:s3cret@egress:1080' } }),
    );
    expect(socks).toContain('X_CONFIG_INVALID');
    expect(socks).toContain('outbound.proxy');
    expect(socks).toContain('socks5:');
    expect(socks).not.toContain('s3cret');
    const garbage = refusal(() =>
      defineConfig({ name: 'app', outbound: { proxy: 'user:s3cret egress' } }),
    );
    expect(garbage).toContain('outbound.proxy');
    expect(garbage).not.toContain('s3cret');
  });

  test('a direct entry must be a bare host name: no scheme, path, port or wildcard', () => {
    for (const entry of ['https://vault.internal', 'vault.internal/x', '*.internal', '', 'a b']) {
      const said = refusal(() => defineConfig({ name: 'app', outbound: { direct: [entry] } }));
      expect(said).toContain('outbound.direct');
    }
    expect(
      defineConfig({ name: 'app', outbound: { direct: ['10.0.0.7', 'svc'] } }).outbound.direct,
    ).toEqual(['10.0.0.7', 'svc']);
  });

  test('an unknown key under outbound is refused by name', () => {
    const untyped: unknown = { name: 'app', outbound: { noProxy: ['a'] } };
    expect(refusal(() => defineConfig(untyped as never))).toContain('outbound.noProxy');
  });
});
