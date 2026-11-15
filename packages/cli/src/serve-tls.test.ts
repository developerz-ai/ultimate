// `ROLE=web` with `TLS_CERT`/`TLS_KEY`, booted for real over the smallest app: the container's
// own listener serves https and counts it as secure (HSTS, no proxy header), and a half pair is
// refused before any service starts.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun.file().exists() answers false for a directory, so it cannot see pgdata.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture app root is joined to this directory.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { selfSignedCertificate } from './dev-tls';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-tls-fixture'));
afterAll(() => rm(ROOT, { recursive: true, force: true }));

async function writeApp(): Promise<void> {
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'serve-tls', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: 'serve-tls' });\n",
  );
}

describe('integration · the container web role on TLS_CERT and TLS_KEY', () => {
  test('serves https, and a pipeline answer carries HSTS with no forwarded header', async () => {
    await writeApp();
    // The real instant: the preload freezes the clock, and TLS checks the machine's.
    const pair = await selfSignedCertificate({
      names: ['localhost'],
      now: new Date(performance.timeOrigin + performance.now()),
    });
    await Bun.write(join(ROOT, 'tls', 'cert.pem'), pair.cert);
    await Bun.write(join(ROOT, 'tls', 'key.pem'), pair.key);
    const env = {
      NODE_ENV: 'test',
      HOST: 'localhost',
      ULTIMATE_STATE_DIR: join(ROOT, '.x'),
      TLS_CERT: join(ROOT, 'tls', 'cert.pem'),
      TLS_KEY: join(ROOT, 'tls', 'key.pem'),
    };
    const web = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
    try {
      expect(web.url).toStartWith('https://localhost:');
      const answer = await fetch(`${web.url}/no-such-page`, { tls: { ca: pair.cert } });
      await answer.arrayBuffer();
      expect(answer.status).toBe(404);
      expect(answer.headers.get('strict-transport-security')).toStartWith('max-age=');
    } finally {
      await web.stop();
      resetLifecycle();
    }
  }, 60_000);

  test('TLS_CERT without TLS_KEY is X_CONFIG_INVALID, before the boot opens anything', async () => {
    await writeApp();
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x-half'), TLS_CERT: '/x.pem' };
    const refusal = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 }).then(
      () => expect.unreachable('a half pair booted'),
      (error: unknown) => error as { code: string },
    );
    expect(refusal.code).toBe('X_CONFIG_INVALID');
    expect(existsSync(join(ROOT, '.x-half', 'pgdata'))).toBe(false);
    resetLifecycle();
  });
});
