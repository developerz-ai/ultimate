// The e2e app's process half against a real child — a fixture root whose `apps/web/server.ts` is a
// dozen lines of `Bun.serve`, so the spawn, the readiness poll, the restart-as-deploy and the
// refusal all run for real without a database. The database half is `e2e-app.test.ts`'s.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: the fixture's state is read back over HTTP, and inside `bun test` the testing preload
// SEALS `fetch` — `node:http` is the unsealed door the spawner itself uses.
import { get } from 'node:http';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { spawnE2eApp } from './e2e-spawn';

/** Answers `/readyz`, and `/env` with what it was spawned with — the facts a test can read. */
const SERVER = `
const port = Number(process.env.PORT);
if (process.env.CRASH === '1') { console.error('boom: the fixture refused to start'); process.exit(3); }
Bun.serve({ port, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/readyz') return new Response('ok');
  if (path === '/env') return Response.json({
    node: process.env.NODE_ENV ?? null, env: process.env.ULTIMATE_ENV ?? null,
    app: process.env.APP_URL ?? null, role: process.env.ROLE ?? null,
    build: process.env.BUILD_ID ?? null, extra: process.env.EXTRA ?? null,
    metrics: process.env.METRICS_PORT ?? null,
  });
  return new Response('nope', { status: 404 });
} });
`;

let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-e2e-spawn-'));
  await Bun.write(join(root, 'apps/web/server.ts'), SERVER);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const readJson = (url: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>));
    }).on('error', reject);
  });

describe('spawnE2eApp', () => {
  test('answers once /readyz does, as a development app reachable at its own APP_URL', async () => {
    const app = await spawnE2eApp({
      root,
      mode: 'serve',
      env: { EXTRA: 'from-the-caller' },
      readyTimeoutMs: 20_000,
    });
    try {
      const seen = await readJson(`${app.base}/env`);
      // `NODE_ENV=test` from `bun test` must not reach the app: it turned dev-only seams off.
      expect(seen['node']).toBeNull();
      expect(seen['env']).toBe('development');
      expect(seen['app']).toBe(app.base);
      expect(seen['role']).toBe('web');
      expect(seen['extra']).toBe('from-the-caller');
      // Its own scrape port, never the fixed default a second app would collide on.
      expect(seen['metrics']).not.toBe('9090');
      expect(seen['metrics']).not.toBeNull();
    } finally {
      await app.stop();
    }
  }, 30_000);

  test('restart is a deploy: the same origin, answering with the new environment', async () => {
    const app = await spawnE2eApp({ root, mode: 'serve', env: {}, readyTimeoutMs: 20_000 });
    try {
      expect((await readJson(`${app.base}/env`))['build']).toBeNull();
      await app.restart({ BUILD_ID: 'b2' });
      expect((await readJson(`${app.base}/env`))['build']).toBe('b2');
    } finally {
      await app.stop();
      // Idempotent: a second stop is a no-op, not a throw.
      await app.stop();
    }
  }, 30_000);

  test('an app that dies before it is ready is X_E2E_APP_FAILED, carrying its own output', async () => {
    const error = await spawnE2eApp({
      root,
      mode: 'serve',
      env: { CRASH: '1' },
      readyTimeoutMs: 20_000,
    }).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_E2E_APP_FAILED');
    expect((error as { cause: string }).cause).toContain('/readyz');
    expect((error as { cause: string }).cause).toContain('boom: the fixture refused to start');
  }, 30_000);
});
