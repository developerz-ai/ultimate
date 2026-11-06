/**
 * e2e — a 5xx in a real `x dev` boot becomes a bundle and then a written test (`failureCapture` in
 * `app.config.ts`, `x repro`). The fault is PLANTED in the database: a trigger refuses every new
 * `connections` row, so `connectSite` answers 500 for a reason no code path holds. The chain is
 * real end to end — the bundle in `x_failures` (input masked: the planted credential is nowhere in
 * it), `x repro --list`, the file `--write` puts in `repro/`, and `--verify` running it — and the
 * verdict is the honest one: replayed on the test driver the insert succeeds, so it is
 * `X_REPRO_NOT_REPRODUCED`, naming the build. A fault in CODE replays red
 * (`packages/testing/src/repro.test.ts`). Needs a Postgres: skips without `TEST_DATABASE_URL`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: a throwaway state directory for the spawned `x dev`; Bun has no temp-dir primitive.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: where that directory goes.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { allowHost, testSealKeyEnv } from '@ultimat3/testing';
import { APP_ROOT, DEMO_MEMBER_COOKIE, POSTS } from './fixtures/postly';

const base = Bun.env['TEST_DATABASE_URL'];
const SECRET = `planted-credential-${crypto.randomUUID()}`;
const DATABASE = `repro_e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = (name: string): string => {
  const url = new URL(base ?? 'postgres://localhost/postgres');
  url.pathname = `/${name}`;
  return url.toString();
};

/**
 * The app's environment on the scratch database: a development process (no `NODE_ENV=test`, the
 * harness's rule), the test seal key handed down by value, and `x dev`'s ports apart from 9090.
 */
const appEnv = (
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> => {
  const { NODE_ENV: _test, ...rest } = Bun.env;
  return {
    ...rest,
    ...testSealKeyEnv({ root: APP_ROOT }),
    ULTIMATE_ENV: 'development',
    DATABASE_URL: databaseUrl(DATABASE),
    ...extra,
  };
};

/** `x <args>` in the app, on the scratch database, answering its `--json` and exit code. */
async function x(
  args: readonly string[],
): Promise<{ readonly code: number; readonly json: unknown }> {
  const child = Bun.spawn(['bun', 'run', 'x', ...args, '--json'], {
    cwd: APP_ROOT,
    env: appEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // The one `--json` answer; the app's own boot log lines and bun's exit line sit around it.
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('{"ok"')) ?? 'null';
  return { code, json: JSON.parse(line) };
}

/** A port the OS just handed out, and its neighbour `x dev` binds the sync node on. */
const freePort = (): number => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

/**
 * `x dev` on the scratch database, answered once `/readyz` is. `--role web`: on an external
 * Postgres the in-process bus has no replicator, and `x dev`'s sync role refuses that topology.
 */
interface DevApp {
  readonly base: string;
  readonly child: Bun.Subprocess;
  readonly stateDir: string;
}

async function bootDev(): Promise<DevApp> {
  const port = freePort();
  const base = `http://localhost:${String(port)}`;
  // The preload seals `fetch`; this app is another process, so its one origin is let through.
  allowHost(new URL(base).host);
  const stateDir = await mkdtemp(join(tmpdir(), 'repro-e2e-'));
  const child = Bun.spawn(['bun', 'run', 'x', 'dev', '--port', String(port), '--role', 'web'], {
    cwd: APP_ROOT,
    env: appEnv({
      APP_URL: base,
      METRICS_PORT: String(freePort()),
      ULTIMATE_STATE_DIR: stateDir,
    }),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const up = await fetch(`${base}/readyz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { base, child, stateDir };
    // real-clock: another process's boot, polled on the wall clock it runs on.
    await Bun.sleep(250);
  }
  child.kill();
  return expect.unreachable(`x dev never answered ${base}/readyz`);
}

const dataOf = (json: unknown): Record<string, unknown> =>
  typeof json === 'object' && json !== null && 'data' in json
    ? (json.data as Record<string, unknown>)
    : {};

describe.skipIf(base === undefined)('a planted 5xx, through x repro', () => {
  let app: DevApp | undefined;
  let admin: Bun.SQL;
  let written: string | undefined;

  beforeAll(async () => {
    admin = new Bun.SQL(databaseUrl('postgres'), { max: 1 });
    await admin.unsafe(`create database ${DATABASE}`);
    expect((await x(['db', 'migrate'])).code).toBe(0);
    expect((await x(['db', 'seed', '--tier', 'dev'])).code).toBe(0);
    app = await bootDev();
    const plant = new Bun.SQL(databaseUrl(DATABASE), { max: 1 });
    await plant.unsafe(`
      create function repro_plant() returns trigger language plpgsql as
      $$ begin raise exception 'planted fault'; end $$;
      create trigger repro_plant before insert on connections for each row execute function repro_plant();
    `);
    await plant.end();
  }, 240_000);

  afterAll(async () => {
    if (written !== undefined) await Bun.file(join(APP_ROOT, written)).delete();
    // `repro/` is the command's to create; left empty by this run, it goes too.
    const left = await readdir(join(APP_ROOT, 'repro')).catch(() => ['(absent)']);
    if (left.length === 0) await rm(join(APP_ROOT, 'repro'), { recursive: true });
    app?.child.kill();
    await app?.child.exited;
    if (app !== undefined) await rm(app.stateDir, { recursive: true, force: true });
    await admin?.unsafe(`drop database if exists ${DATABASE} with (force)`);
    await admin?.end();
  }, 60_000);

  test('the 500 is captured, listed, written and verified — and the secret is nowhere', async () => {
    const running = app ?? expect.unreachable('x dev did not boot');
    const response = await fetch(`${running.base}/api/sites/connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: running.base,
        'sec-fetch-site': 'same-origin',
        cookie: `${DEMO_MEMBER_COOKIE}=ada`,
      },
      body: JSON.stringify({ orgId: POSTS.tenancy.orgId, label: 'Ledger', credential: SECRET }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(500);
    const requestId = response.headers.get('x-request-id') ?? '';
    expect(requestId).not.toBe('');

    // The save is never awaited by the response: one more request is time enough on one process.
    const listed = await x(['repro', '--list']);
    const bundles = dataOf(listed.json)['bundles'] as readonly Record<string, unknown>[];
    expect(bundles.some((bundle) => bundle['requestId'] === requestId)).toBe(true);

    const repro = await x(['repro', requestId, '--write', '--verify']);
    const data = dataOf(repro.json);
    written = typeof data['file'] === 'string' ? data['file'] : undefined;
    expect(data['kind']).toBe('request');
    expect(data['masked']).toEqual(['credential']);
    expect(data['reproduced']).toBe(false);
    expect(JSON.stringify(repro.json)).toContain('X_REPRO_NOT_REPRODUCED');
    expect(JSON.stringify(repro.json)).not.toContain(SECRET);
    expect(written).toMatch(/^repro\/repro-[a-z0-9]+\.contract\.test\.ts$/);
    expect(await Bun.file(join(APP_ROOT, written ?? '')).text()).not.toContain(SECRET);
  }, 120_000);
});
