// `x dev` end to end, against a real app on disk: PGlite boots, the jobs table is created, the
// app's modules register, and the actions those modules declared answer over the same HTTP
// pipeline production runs. A fixture that stubbed any of that would prove nothing — the bug this
// replaces was a dev server that served `/_x` and 404'd every route the app actually had.
//
// `/_x` here is `@ultimat3/admin`'s dashboard, mounted. The assertions below read the panels'
// own payloads, so a CLI that grew a second copy of one would fail this file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { declareTags, invalidateTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { createContext, logger, runWithContext, userActor } from '@ultimat3/core';
import { statementObserver } from '@ultimat3/db';
import { cspHashSource } from '@ultimat3/http';
import { SyncSocket } from '@ultimat3/realtime/server';
import type { DevServer } from './cmd-dev';
import { devCommand, startDev } from './cmd-dev';
import { FakeWs, DEV_FIXTURE_FILES as FILES, resetRegistries } from './cmd-dev-fixture';
import { CliNotImplementedError } from './errors';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve through the same tsconfig
// paths the framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.dev-fixture');

let server: DevServer;

/**
 * Booting embedded Postgres, the queue and the HTTP role is seconds of real work, and bun's
 * default hook budget is 5s — close enough to this boot that a loaded machine decided whether the
 * file passed. Every timeout in this file is explicit and generous for that reason: a hang should
 * be reported as a hang, never as a boot that was 300ms slower than the runner's default.
 */
const BOOT_TIMEOUT_MS = 60_000;

/** Bound and released: `METRICS_PORT` is read as a NAMED port, so it can be neither 0 nor 9090. */
const METRICS_PORT = ((): number => {
  const probe = Bun.serve({ port: 0, hostname: 'localhost', fetch: () => new Response('') });
  const port = Number(new URL(probe.url).port);
  probe.stop(true);
  return port;
})();

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetRegistries();
  // Port 0 asks the OS for a free one, so this suite never collides with a running `x dev`.
  // `METRICS_PORT` is named, because `x dev` ignoring it is the thing under test.
  const env = { METRICS_PORT: String(METRICS_PORT) };
  server = await startDev({
    root: ROOT,
    port: 0,
    env,
    roles: ['web', 'sync', 'worker', 'scheduler'],
  });
}, BOOT_TIMEOUT_MS);

/**
 * The tenth registry, and the one `resetRegistries()` must NOT hold: `declareTags` is additive
 * and process-wide, so the `devfixture` this file declares turned on tag validation for every
 * later file — `packages/query`'s read-cache suite then failed X_CACHE_TAG_UNKNOWN on `post`.
 * A reset would drop a neighbour's declarations too; this puts back exactly what was found.
 */
const restoreTags = isolateDeclaredTags();

// The restores go in the `finally`: a rejected `stop()` or `rm()` would otherwise skip them and
// hand every later file in this process a registry this file filled — the exact leak above.
afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetRegistries();
    restoreTags();
  }
}, BOOT_TIMEOUT_MS);

const fetchDev = (path: string, init?: RequestInit): Promise<Response> => {
  const handle = server.running.server;
  // Never a bare Error, tests included: a throw without a code and a fix is not an instruction.
  if (handle === null) {
    throw new CliNotImplementedError({
      feature: 'fetching from x dev without the web role',
      fix: 'x dev --role web',
    });
  }
  return handle.fetch(new Request(`http://dev.test${path}`, init));
};

describe('unit · x dev boots the app', () => {
  test('every selected role is running, and the unselected ones are not', () => {
    expect(server.roles).toEqual(['web', 'sync', 'worker', 'scheduler']);
    expect(server.running.worker).not.toBeNull();
    expect(server.running.scheduler).not.toBeNull();
    expect(server.running.syncUrl).not.toBeNull();
    expect(server.findings).toEqual([]);
  });

  // `cmd-dev.ts` passed no `metricsPort`, so `METRICS_PORT` moved the scrape port in the container
  // and did nothing here — where it bound 9090 and the second `x dev` on the box died on it.
  test('x dev honours METRICS_PORT, the same variable the container reads', async () => {
    expect(new URL(server.running.metricsUrl).port).toBe(String(METRICS_PORT));
    expect((await fetch(`${server.running.metricsUrl}/metrics`)).status).toBe(200);
  });

  test('the app loaded cleanly and its actions are mounted as HTTP routes', async () => {
    const response = await fetchDev('/api/posts/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: 'hi' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ word: 'hi' });
  });

  test("an action's policy is enforced by the pipeline, not skipped in dev", async () => {
    const response = await fetchDev('/api/posts/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(response.status).toBe(401);
  });

  test('a page route registered by the app renders its own head', async () => {
    const response = await fetchDev('/pricing');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Pricing</title>');
  });

  test('/_x serves the dashboard shell, with a tab per mounted panel', async () => {
    const response = await fetchDev('/_x');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const shell = await response.text();
    for (const key of server.panels) expect(shell).toContain(`href="/_x/${key}"`);
    expect(server.panels).toHaveLength(11);
  });

  test('/_x/routes?json=1 is the panel payload, naming the route the fixture registered', async () => {
    const payload = (await (await fetchDev('/_x/routes?json=1')).json()) as {
      panel: string;
      ok: boolean;
      data: { routes: { path: string }[] };
    };
    expect(payload).toMatchObject({ panel: 'routes', ok: true });
    expect(payload.data.routes.map((route) => route.path)).toContain('/pricing');
  });

  test('/_x/services reports the roles and services this process actually booted', async () => {
    const payload = (await (await fetchDev('/_x/services?json=1')).json()) as {
      ok: boolean;
      data: { roles: string[]; services: { db: { mode: string } }; reloads: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.roles).toEqual(['web', 'sync', 'worker', 'scheduler']);
    expect(payload.data.services.db.mode).toBe('embedded');
    expect(payload.data.reloads).toBe(0);
  });

  test('/_x/db reads the embedded Postgres and refuses a write statement', async () => {
    const read = (await (await fetchDev('/_x/db?json=1&sql=select%201%20as%20n')).json()) as {
      ok: boolean;
      data: { result: { columns: string[]; rows: unknown[][] } | null; refused: string | null };
    };
    expect(read.ok).toBe(true);
    expect(read.data.refused).toBeNull();
    expect(read.data.result?.columns).toEqual(['n']);
    expect(read.data.result?.rows).toEqual([[1]]);

    const write = (await (await fetchDev('/_x/db?json=1&sql=delete%20from%20x_jobs')).json()) as {
      data: { result: unknown; refused: string | null };
    };
    // Asserts the two halves an operator needs, not the prose around them: WHICH word made it a
    // write, and the one command that runs it anyway. Matching a phrase like "read-only" passed
    // for a refusal that named neither — and it broke the moment the panel stopped calling a
    // syntax error a permissions problem.
    expect(write.data.refused).toContain('"delete"');
    expect(write.data.refused).toContain('x db psql --write');
    expect(write.data.result).toBeNull();
  });

  test('/_x/manifest is the loaded app, diffed against the committed file', async () => {
    const payload = (await (await fetchDev('/_x/manifest?json=1')).json()) as {
      ok: boolean;
      data: {
        drifted: boolean;
        added: string[];
        manifest: {
          committed: unknown;
          emitted: {
            app: { name: string; version: string };
            actions: { name: string }[];
            routes: { url: string }[];
          };
        };
      };
    };
    expect(payload.ok).toBe(true);
    const emitted = payload.data.manifest.emitted;
    expect(emitted.app).toEqual({ name: 'dev-fixture', version: '1.4.0' });
    expect(emitted.actions.map((action) => action.name).sort()).toEqual([
      'echoPost',
      'publishPost',
    ]);
    expect(emitted.routes.map((route) => route.url)).toEqual(['/pricing']);
    // The fixture never ran `x manifest`, so every key reads as added rather than as changed.
    expect(payload.data.manifest.committed).toBeNull();
    expect(payload.data.drifted).toBe(true);
    expect(payload.data.added).toContain('app');
  });

  test('/_x/timeline is the request this process just served, not a refusal', async () => {
    await fetchDev('/api/posts/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: 'traced' }),
    });

    const payload = (await (await fetchDev('/_x/timeline?json=1')).json()) as {
      ok: boolean;
      data: {
        requests: { requestId: string; path: string }[];
        selected: { status: number; spans: { kind: string; name: string }[] } | null;
        totalsByKind: Record<string, number>;
      };
    };
    expect(payload.ok).toBe(true);
    // The action's own route, recorded through core's tracer — the panel was `X_NOT_IMPLEMENTED`
    // until `x dev` installed an exporter, because tracing is free and off until one is configured.
    const served = payload.data.requests.find((entry) => entry.path === '/api/posts/echo');
    expect(served).toBeDefined();
    expect(served?.requestId.length).toBeGreaterThan(0);
    expect(payload.data.selected?.spans.some((span) => span.kind === 'http')).toBe(true);
    expect(Object.keys(payload.data.totalsByKind)).toContain('http');
  });

  // Installing a `StatementObserver` is the single switch that turns statement instrumentation on
  // (`@ultimat3/db`'s `observe.ts`), and `x dev` is what throws it — `serve.ts` never does. Until
  // it did, the timeline had no DB children at all and `repeatedSql` grouped span names, which is
  // what made an N+1 invisible in the one panel built to show it.
  test('x dev installs the statement ledger, so the timeline has SQL children', async () => {
    expect(statementObserver()).toBeDefined();
    await fetchDev('/_x/db?json=1&sql=select%201%20as%20n');

    const payload = (await (await fetchDev('/_x/timeline?json=1')).json()) as {
      data: { requests: { requestId: string; path: string }[] };
    };
    const read = payload.data.requests.find((entry) => entry.path === '/_x/db');
    expect(read).toBeDefined();

    const trace = (await (
      await fetchDev(`/_x/timeline?json=1&requestId=${read?.requestId ?? ''}`)
    ).json()) as {
      data: { selected: { spans: { kind: string; name: string; detail: string }[] } | null };
    };
    const sql = trace.data.selected?.spans.filter((span) => span.kind === 'sql') ?? [];
    expect(sql.length).toBeGreaterThan(0);
    // The statement states its own identity: the span's detail is the SQL, not `db.select`.
    expect(sql.some((span) => span.name.startsWith('db.') && span.detail !== span.name)).toBe(true);
  });

  // The four surfaces, wired to the one ledger. This proves the wiring end to end rather than the
  // counting, which `dev-n-plus-one.test.ts` owns: the observer under test here is the one the
  // running process installed, fed the events `@ultimat3/db`'s funnels feed it.
  test('a loop in one request reaches x dev, /_x, the overlay and the log — from one ledger', async () => {
    const observer = statementObserver();
    expect(observer).toBeDefined();

    const before = server.findings.length;
    const lines: string[] = [];
    const printWarning = logger.warn;
    logger.warn = (line: string): void => {
      lines.push(line);
    };
    const ctx = createContext({ requestId: 'req_looped' });
    try {
      runWithContext(ctx, () => {
        for (let sent = 0; sent < 6; sent += 1) {
          observer?.onStatement({
            text: 'select "id" from "members" where "id" = $1',
            values: [],
            durationMs: 1,
            rows: 1,
            attribution: { entity: 'members', op: 'findById' },
          });
        }
      });
    } finally {
      logger.warn = printWarning;
    }

    // 1. `x dev`'s own findings — text and `--json` render it for free.
    const findings = server.findings;
    expect(findings.length).toBe(before + 1);
    const finding = findings[findings.length - 1];
    expect(finding?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(finding?.at).toBe('req_looped');
    expect(finding?.fix).toContain("db.members.andWhere('id', 'in', ids).all()");

    // 2. the timeline panel, through the source only this process can answer.
    const panel = (await (await fetchDev('/_x/timeline?json=1')).json()) as {
      data: { nPlusOne: { code: string; requestId: string; count: number }[] | null };
    };
    // Wired, so never `null` — this request is not on screen, so its own list is empty.
    expect(panel.data.nPlusOne).toEqual([]);

    // 3. the log line: one per request per code, carrying the ids core puts on every line in scope.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('X_N_PLUS_ONE_QUERY: members.findById ran 5 times');
    expect(lines[0]).toContain('fix: ');
  });

  test("/_x/policy is the app's real matrix: one column per declared role", async () => {
    const payload = (await (await fetchDev('/_x/policy?json=1')).json()) as {
      ok: boolean;
      data: {
        actors: string[];
        permissions: string[];
        matrix: { permission: string; byActor: Record<string, boolean> }[];
        unreachable: string[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.actors).toEqual(['anonymous', 'author', 'reader']);
    expect(payload.data.permissions).toContain('post:publish');

    const publish = payload.data.matrix.find((row) => row.permission === 'post:publish');
    // The grant the fixture's `defineRoles` actually made, decided by the fixture's own policy.
    expect(publish?.byActor['author']).toBe(true);
    expect(publish?.byActor['reader']).toBe(false);
    expect(publish?.byActor['anonymous']).toBe(false);
    expect(payload.data.unreachable).not.toContain('post:publish');
  });

  test('/_x/cache is the invalidation log, instead of a 500 where the tab should be', async () => {
    declareTags(['devfixture']);
    await invalidateTags([tag('devfixture', 'p_1')]);

    const response = await fetchDev('/_x/cache?json=1');
    // Before the log existed this panel could not answer at all: the unwired source threw
    // synchronously, past the panel's own `.catch`, and the whole tab was a 500.
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: { invalidations: { tags: string[] }[]; note: string | null };
    };
    expect(payload.ok).toBe(true);
    // The log is process-global, so this asserts the bust is present rather than that it is alone.
    expect(payload.data.invalidations.some((event) => event.tags.includes('devfixture:p_1'))).toBe(
      true,
    );
    expect(payload.data.note).toBeNull();
  });

  test('every mounted panel answers — no tab is a dead end', async () => {
    const refused: string[] = [];
    for (const key of server.panels) {
      const body = (await (await fetchDev(`/_x/${key}?json=1`)).json()) as { ok: boolean };
      if (!body.ok) refused.push(key);
    }
    // Four of these eleven refused before this wiring: timeline, cache and policy had no source
    // at all, and the refusal threw past the panels' own degradation on the way out.
    expect(refused).toEqual([]);
  });

  test('/_x/live names the live query, and says its subscriber source is unwired rather than empty', async () => {
    const payload = (await (await fetchDev('/_x/live?json=1')).json()) as {
      ok: boolean;
      data: { queries: { name: string }[]; subscribers: unknown[]; note: string | null };
    };
    // The queries come off the registry this boot's sync node holds. `subscribers` is the one
    // source still unwired — `@ultimat3/realtime` records no matcher trace, and that trace is the
    // panel's whole question — so the panel degrades to its note even with the node running; an
    // empty list with no note would read as "nobody is subscribed", which is a different claim.
    expect(payload.ok).toBe(true);
    expect(payload.data.queries.map((query) => query.name)).toContain('liveNotes');
    expect(payload.data.subscribers).toEqual([]);
    expect(payload.data.note).toBe('dev.live.no-sync-node');
  });

  test('an unknown /_x path 404s with a code, a cause and a fix', async () => {
    const response = await fetchDev('/_x/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; cause: string; fix: string };
    expect(body.code).toBe('X_ROUTE_NOT_FOUND');
    expect(body.cause).toContain('/_x/nope');
    expect(body.fix.length).toBeGreaterThan(0);
  });

  test('the embedded database is real Postgres — the jobs table exists in it', async () => {
    const rows = await server.runtime.db.query<{ table_name: string }>({
      text: "select table_name from information_schema.tables where table_name = 'x_jobs'",
      values: [],
    });
    expect(rows).toHaveLength(1);
  });

  // `POST /mcp` answered X_ROUTE_NOT_FOUND in every process the framework booted until 2026-09-05:
  // `defineAppMcp` built the route and no boot mounted it. 401 is the route's own verdict on a
  // request with no bearer token, and the boot report names the mount.
  test("the app's MCP endpoint is mounted, and the boot report names it", async () => {
    expect((await fetchDev('/mcp', { method: 'POST' })).status).not.toBe(404);
    expect(server.mcp).toBe('/mcp');
  });

  // `x dev` passed no app middleware at all until 2026-09-05 — only the read-replica override —
  // so an app's chain reached no development process. The fixture's `apps/web/runtime.ts` stamps
  // every response; the stamp on a page the app serves is the chain, composed and running.
  test("the app's apps/web/runtime.ts middleware runs in development", async () => {
    const page = await fetchDev('/pricing');
    expect(page.status).toBe(200);
    expect(page.headers.get('x-dev-runtime')).toBe('app');
  });

  // Under the embedded database a subscription took its snapshot and then heard nothing — PGlite
  // has no walsender and no boot installed a row observer — so every `--live` query in every
  // scaffolded app was dead in development. A real subscription on the real node, one repository
  // write through the fixture's own `database()` handle, one patch frame.
  test('a repository write in this process reaches a live subscriber as a patch', async () => {
    expect(server.running.liveFeed).toBe('in-process');
    const registry = server.running.liveRegistry;
    const bridge = server.running.liveBridge;
    if (registry === null || bridge === null) expect.unreachable('the sync role has no bridge');
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: server.buildId,
      serverBuildId: server.buildId,
      actor: userActor({ id: 'u1' }),
    });
    const { frame } = await registry.subscribe({ socket, name: 'liveNotes', input: {} });
    expect(frame.type).toBe('snapshot');
    ws.frames.length = 0;

    const { db } = (await import(join(ROOT, 'apps/web/app/notes/entity.ts'))) as {
      db: { notes: { insert(row: { id: string; title: string }): Promise<unknown> } };
    };
    await db.notes.insert({ id: crypto.randomUUID(), title: 'first note' });
    await bridge.settled();

    expect(bridge.delivered).toBeGreaterThan(0);
    expect(ws.frames.map((sent) => sent.type)).toContain('patch');
  });

  test('--role is a declared flag with the dev roles in its summary', () => {
    const role = devCommand.spec.flags?.find((flag) => flag.name === 'role');
    expect(role?.summary).toContain('web,sync,worker,scheduler');
  });
});

/**
 * The policy `x dev` sends, against the documents `x dev` serves. Report-only here — which is
 * precisely why the production breakage went unseen: in dev the browser reports the violation and
 * paints the page anyway, and only an enforced policy blanks it. The sources are the same either
 * way, so this is the wiring's end-to-end pin: the app's surfaces AND the `/_x` shell.
 */
describe('unit · x dev sends a policy that admits its own inline styles', () => {
  const uncovered = (body: string, csp: string): readonly string[] =>
    [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1] ?? '')
      .filter((css) => !csp.includes(cspHashSource(css)));

  const check = async (path: string): Promise<readonly string[]> => {
    const response = await fetchDev(path, { headers: { accept: 'text/html' } });
    const csp = response.headers.get('content-security-policy-report-only') ?? '';
    return uncovered(await response.text(), csp);
  };

  test("a page's own stylesheet is named by the policy that page is served under", async () => {
    expect(await check('/pricing')).toEqual([]);
  });

  test('the /_x shell is named too, because x dev is what mounted it', async () => {
    expect(await check('/_x/routes')).toEqual([]);
  });
});
