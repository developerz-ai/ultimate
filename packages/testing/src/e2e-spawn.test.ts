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
import { E2E_APP_STOP_MS, inherited, READY_PROBE_MS, spawnE2eApp } from './e2e-spawn';

/** Answers `/readyz`, and `/env` with what it was spawned with — the facts a test can read. */
const SERVER = `
const port = Number(process.env.PORT);
if (process.env.CRASH === '1') { console.error('boom: the fixture refused to start'); process.exit(3); }
if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => console.error('SIGTERM ignored'));
Bun.serve({ port, fetch(req) {
  const path = new URL(req.url).pathname;
  // Accepts the connection and never answers: an app wedged in its boot.
  if (path === '/readyz' && process.env.HANG === '1') return new Promise(() => {});
  if (path === '/readyz') return new Response('ok');
  if (path === '/shout') { console.error('X_FIXTURE_LOUD: what the server said'); return new Response('ok'); }
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

  // A live-path bug fails a browser assertion; the server's side of it was visible only by
  // re-running the app by hand. The spawned app's log is kept, bounded, for a failing test to carry.
  test('log() answers what the app printed while it ran', async () => {
    const app = await spawnE2eApp({ root, mode: 'serve', env: {}, readyTimeoutMs: 20_000 });
    try {
      await readJson(`${app.base}/env`);
      await new Promise<void>((resolve) => {
        get(`${app.base}/shout`, (response) => {
          response.resume();
          response.on('end', resolve);
        });
      });
      // The pipe is drained in the background: give it the turns it needs, never a wall-clock wait.
      for (let turn = 0; turn < 200 && !app.log().includes('X_FIXTURE_LOUD'); turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(app.log()).toContain('X_FIXTURE_LOUD: what the server said');
    } finally {
      await app.stop();
    }
  }, 30_000);

  // `stopped` stayed true through a restart, so the respawned child was one no later stop() could
  // kill — it outlived the test. A stopped app is finished: restart refuses, and spawns nothing.
  test('restart after stop is refused, and no process is left behind', async () => {
    const app = await spawnE2eApp({ root, mode: 'serve', env: {}, readyTimeoutMs: 20_000 });
    await app.stop();

    const error = await app.restart({ BUILD_ID: 'b2' }).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_INVARIANT');
    expect(await readJson(`${app.base}/env`).catch(() => 'nothing listening')).toBe(
      'nothing listening',
    );
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

  test('stop is bounded: an app that ignores SIGTERM is killed after the grace, never awaited forever', async () => {
    const app = await spawnE2eApp({
      root,
      mode: 'serve',
      env: { IGNORE_TERM: '1' },
      readyTimeoutMs: 20_000,
      termGraceMs: 200,
    });
    const began = performance.now();

    await app.stop();

    expect(performance.now() - began).toBeLessThan(5_000);
    expect(await readJson(`${app.base}/env`).catch(() => 'nothing listening')).toBe(
      'nothing listening',
    );
  }, 30_000);

  test('the readiness deadline is wall-clock time, not a count of polls that each wait a probe', async () => {
    const began = performance.now();
    const error = await spawnE2eApp({
      root,
      mode: 'serve',
      env: { HANG: '1' },
      readyTimeoutMs: 1_000,
    }).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_E2E_APP_FAILED');
    // One deadline, one probe past it at most, and the stop of an app that answers SIGTERM.
    expect(performance.now() - began).toBeLessThan(1_000 + READY_PROBE_MS + 1_000);
  }, 30_000);

  test("the stop budget covers the app's own drain at its defaults, then the kill", () => {
    expect(E2E_APP_STOP_MS).toBeGreaterThan(25_000);
  });
});

// #674: the harness boots the app on a THROWAWAY state directory, and an exported DATABASE_URL (a
// developer's integration-test Postgres) rode along — `x db reset` refused the external database
// and the whole e2e step went red for a reason the change under test had nothing to do with.
describe('unit · the environment an e2e app inherits', () => {
  const KEYS = ['DATABASE_URL', 'S3_ENDPOINT', 'EXTRA_KEPT'] as const;
  const saved = new Map(KEYS.map((key) => [key, Bun.env[key]]));
  afterAll(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  });

  test('the bindings the state directory owns are dropped; everything else rides along', () => {
    Bun.env['DATABASE_URL'] = 'postgres://dev:dev@127.0.0.1:5432/integration';
    Bun.env['S3_ENDPOINT'] = 'http://127.0.0.1:9000';
    Bun.env['EXTRA_KEPT'] = 'kept';
    const env = inherited();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['S3_ENDPOINT']).toBeUndefined();
    expect(env['EXTRA_KEPT']).toBe('kept');
    expect(env['NODE_ENV']).toBeUndefined();
    expect(env['ULTIMATE_ENV']).toBe('development');
  });
});
