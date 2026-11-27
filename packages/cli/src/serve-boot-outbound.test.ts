// `outbound.proxy` in `app.config.ts` is installed by the boot, so every `outbound()` call a served
// role makes with no proxy of its own — a framework sender's included — goes through it, and the
// stop takes it away again. The boot line names the proxy without its credential.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { installLogSink, resetLifecycle } from '@ultimat3/core';
import type { OutboundFetch, OutboundInit } from '@ultimat3/core/outbound';
import { outbound } from '@ultimat3/core/outbound';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-outbound-fixture'));

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetLifecycle();
});

/** The proxy one named call to `url` was handed, through a transport that records it. */
async function proxyOf(url: string): Promise<OutboundInit['proxy']> {
  const seen: OutboundInit[] = [];
  const fetch: OutboundFetch = (_target, init) => {
    seen.push(init);
    return Promise.resolve(new Response('ok'));
  };
  await outbound({ url, vendor: 'apns', dial: 'named', deadlineMs: 5_000 }, { fetch });
  return seen[0]?.proxy;
}

describe('unit · the boot installs the app-wide egress proxy', () => {
  test('declared, a served role sends through it; stopped, it is gone', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'egress', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        'export const config = defineConfig({\n' +
        "  name: 'egress',\n" +
        "  outbound: { proxy: 'http://user:s3cret@egress.internal:3128', direct: ['vault.internal'] },\n" +
        '});\n',
    );
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x'), BUILD_ID: 'b-1' };
    const lines: string[] = [];
    const release = installLogSink((line) => lines.push(line));
    let served: Awaited<ReturnType<typeof serveApp>>;
    try {
      served = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    } finally {
      release();
    }
    if (served.kind !== 'served') return expect.unreachable('a worker boot serves');
    try {
      expect(await proxyOf('https://api.push.test/3/device')).toEqual({
        url: 'http://user:s3cret@egress.internal:3128/',
      });
      expect(await proxyOf('http://vault.internal/v1/kv')).toBeUndefined();
      const said = lines.join('\n');
      expect(said).toContain('egress.internal:3128');
      expect(said).not.toContain('s3cret');
    } finally {
      await served.stop();
    }
    expect(await proxyOf('https://api.push.test/3/device')).toBeUndefined();
  }, 120_000);
});
