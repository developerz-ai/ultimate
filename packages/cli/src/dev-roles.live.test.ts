// Two `web` replicas, one rate limit. `docker/helm/values.yaml` runs `roles.web.replicas: 3` and
// `x new` scaffolds two, and the boot installed no store at all — so `rateLimit.scope` derived to
// `'process'` on every deployment the framework has ever produced, `login: { limit: 5 }` was
// enforced as fifteen attempts across three pods, and `X_RATE_LIMIT_NOT_SHARED` could never fire.
//
// Two servers in ONE process is the honest model of that: they share nothing but the database,
// which is exactly what two pods share.
//
// Skips unless `TEST_DATABASE_URL` is set. Locally:
//
//   docker run -d --name x-limit -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/dev-roles.live.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import type { RunningRoles } from './dev-roles';
import { startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BOOT_TIMEOUT_MS = 60_000;

/** Its own database: this file writes framework tables and drops them with it. */
const PROBE_DB = 'x_ratelimit_probe';

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const admin = async (statement: string): Promise<void> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

/**
 * The `auth` bucket: capacity 10, refill 0.2/s. The narrowest one the framework declares, so the
 * case is a dozen requests rather than a quarter of a thousand — and it is the bucket the number
 * actually matters for, since it is the one a login route selects.
 */
const guarded: Route = {
  method: 'GET',
  path: '/login',
  meta: { name: 'login', auth: 'public', rateLimit: 'auth' },
  handler: () => new Response('ok'),
};

const AUTH_BUCKET_CAPACITY = 10;

let replicas: RunningRoles[] = [];
let runtime: RunningServices | undefined;
let root: string | undefined;

afterEach(async () => {
  for (const replica of replicas) await replica.stop();
  replicas = [];
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  resetLifecycle();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
});

/** One replica's worth of `web`, on its own ephemeral port and its own scrape port. */
async function replica(services: RunningServices): Promise<string> {
  const running = await startRoles({
    roles: ['web'],
    port: 0,
    metricsPort: 0,
    buildId: 'build-1',
    runtime: services,
    routes: [guarded],
    env: {},
  });
  replicas.push(running);
  return running.url ?? expect.unreachable('the web role reported no url');
}

describeLive('the rate limit is the fleet’s, not each replica’s', () => {
  test(
    'a second replica sees the first one’s spend, and refuses past the declared capacity',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'x-ratelimit-'));
      await admin(`drop database if exists ${PROBE_DB} with (force)`);
      await admin(`create database ${PROBE_DB}`);
      const dbUrl = probeUrl();
      runtime = await startServices(resolveServices(root, { DATABASE_URL: dbUrl }), {
        DATABASE_URL: dbUrl,
      });
      const first = await replica(runtime);
      const second = await replica(runtime);

      // Half the bucket on each, then one more. Sequential on purpose: the store's `on conflict`
      // upsert is what makes concurrent takes safe, and this test is about the SCOPE.
      const codes: number[] = [];
      for (let i = 0; i < AUTH_BUCKET_CAPACITY + 2; i += 1) {
        const base = i % 2 === 0 ? first : second;
        codes.push((await fetch(`${base}/login`)).status);
      }

      // Observed before this landed: twelve 200s — the two servers each held their own in-memory
      // bucket, so `capacity: 10` was enforced as twenty.
      expect(codes.filter((code) => code === 200).length).toBeLessThanOrEqual(AUTH_BUCKET_CAPACITY);
      expect(codes.at(-1)).toBe(429);

      // One bucket, in one row, under one key — which is the claim `scope: 'shared'` makes.
      const sql = new Bun.SQL(dbUrl, { max: 1 });
      try {
        const rows = await sql.unsafe('select key from x_rate_limit', []);
        expect(rows.length).toBe(1);
      } finally {
        await sql.end();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
