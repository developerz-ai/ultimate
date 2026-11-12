// `x dev` end to end, against a real app on disk: PGlite boots, the jobs table is created, the
// app's modules register, and the actions those modules declared answer over the same HTTP
// pipeline production runs. A fixture that stubbed any of that would prove nothing — the bug this
// replaces was a dev server that served `/_x` and 404'd every route the app actually had.
// The `/_x` panels' own payloads are `cmd-dev-panels.test.ts`'s; the boot is `cmd-dev-boot-fixture.ts`.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ctxOf, instrument, logger, runWithContext, subscribed, userActor } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { SyncSocket } from '@ultimat3/realtime/server';
import { devCommand } from './cmd-dev';
import { bootDevFixture } from './cmd-dev-boot-fixture';
import { FakeWs } from './cmd-dev-fixture';

const dev = bootDevFixture('.dev-fixture');
const portOf = (url: string | null): number => Number(new URL(url ?? '').port);

describe('unit · x dev boots the app', () => {
  test('every selected role is running, and the unselected ones are not', () => {
    expect(dev.server.roles).toEqual(['web', 'sync', 'worker', 'scheduler']);
    expect(dev.server.running.worker).not.toBeNull();
    expect(dev.server.running.scheduler).not.toBeNull();
    // At --port 0 the kernel picks the sync port too — never web + 1, which another socket may hold.
    expect(portOf(dev.server.running.syncUrl)).not.toBe(portOf(dev.server.url));
    expect(dev.server.findings).toEqual([]);
  });

  // `cmd-dev.ts` passed no `metricsPort`, so `METRICS_PORT` moved the scrape port in the container
  // and did nothing here — where it bound 9090 and the second `x dev` on the box died on it.
  test('x dev honours METRICS_PORT, the same variable the container reads', async () => {
    expect(new URL(dev.server.running.metricsUrl).port).toBe(String(dev.metricsPort));
    expect((await fetch(`${dev.server.running.metricsUrl}/metrics`)).status).toBe(200);
  });

  test('the app loaded cleanly and its actions are mounted as HTTP routes', async () => {
    const response = await dev.fetchDev('/api/posts/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: 'hi' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ word: 'hi' });
  });

  test("an action's policy is enforced by the pipeline, not skipped in dev", async () => {
    const response = await dev.fetchDev('/api/posts/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(response.status).toBe(401);
  });

  test('a page route registered by the app renders its own head', async () => {
    const response = await dev.fetchDev('/pricing');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Pricing</title>');
  });

  // The `Server-Timing` breakdown and the slow-request line read what this subscriber heard;
  // `render.page` has no other subscriber in `x dev`, so it is this one's switch.
  test('x dev installs the request timings beside the semconv histograms', () => {
    expect(subscribed('render.page')).toBe(true);
  });

  // Subscribing to `db.statement` is the single switch that makes `@ultimat3/db` build statement
  // events, and `x dev` is what subscribes — `serve.ts` never does. Until
  // it did, the timeline had no DB children at all and `repeatedSql` grouped span names, which is
  // what made an N+1 invisible in the one panel built to show it.
  test('x dev installs the statement ledger, so the timeline has SQL children', async () => {
    expect(subscribed('db.statement')).toBe(true);
    await dev.runSql('select 1 as n');

    const payload = (await (await dev.fetchDev('/_x/timeline?json=1')).json()) as {
      data: { requests: { requestId: string; path: string }[] };
    };
    const read = payload.data.requests.find((entry) => entry.path === '/_x/db');
    expect(read).toBeDefined();

    const trace = (await (
      await dev.fetchDev(`/_x/timeline?json=1&requestId=${read?.requestId ?? ''}`)
    ).json()) as {
      data: { selected: { spans: { kind: string; name: string; detail: string }[] } | null };
    };
    const sql = trace.data.selected?.spans.filter((span) => span.kind === 'sql') ?? [];
    expect(sql.length).toBeGreaterThan(0);
    // The statement states its own identity: the span's detail is the SQL, not `db.select`.
    expect(sql.some((span) => span.name.startsWith('db.') && span.detail !== span.name)).toBe(true);
  });

  // The four surfaces, wired to the one ledger. This proves the wiring end to end rather than the
  // counting, which `dev-n-plus-one.test.ts` owns: the events go through the bus the running
  // process subscribed to, exactly as `@ultimat3/db`'s funnels publish them.
  test('a loop in one request reaches x dev, /_x, the overlay and the log — from one ledger', async () => {
    expect(subscribed('db.statement')).toBe(true);

    const before = dev.server.findings.length;
    const lines: string[] = [];
    const printWarning = logger.warn;
    logger.warn = (line: string): void => {
      lines.push(line);
    };
    const ctx = ctxOf({ requestId: 'req_looped' });
    try {
      runWithContext(ctx, () => {
        for (let sent = 0; sent < 6; sent += 1) {
          instrument('db.statement', {
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
    const findings = dev.server.findings;
    expect(findings.length).toBe(before + 1);
    const finding = findings[findings.length - 1];
    expect(finding?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(finding?.at).toBe('req_looped');
    expect(finding?.fix).toContain("db.members.andWhere('id', 'in', ids).all()");

    // 2. the timeline panel, through the source only this process can answer.
    const panel = (await (await dev.fetchDev('/_x/timeline?json=1')).json()) as {
      data: { nPlusOne: { code: string; requestId: string; count: number }[] | null };
    };
    // Wired, so never `null` — this request is not on screen, so its own list is empty.
    expect(panel.data.nPlusOne).toEqual([]);

    // 3. the log line: one per request per code, carrying the ids core puts on every line in scope.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('X_N_PLUS_ONE_QUERY: members.findById ran 5 times');
    expect(lines[0]).toContain('fix: ');
  });

  test('the embedded database is real Postgres — the jobs table exists in it', async () => {
    const rows = await dev.server.runtime.db.query<{ table_name: string }>({
      text: "select table_name from information_schema.tables where table_name = 'x_jobs'",
      values: [],
    });
    expect(rows).toHaveLength(1);
  });

  // `POST /mcp` answered X_ROUTE_NOT_FOUND in every process the framework booted until 2026-09-05:
  // `defineAppMcp` built the route and no boot mounted it. 401 is the route's own verdict on a
  // request with no bearer token, and the boot report names the mount.
  test("the app's MCP endpoint is mounted, and the boot report names it", async () => {
    expect((await dev.fetchDev('/mcp', { method: 'POST' })).status).not.toBe(404);
    expect(dev.server.mcp).toBe('/mcp');
    expect(dev.server.mcpPaths).toEqual(['/mcp']);
  });

  // `x dev` passed no app middleware until 2026-09-05 and no app DISK until 22.4 (it built its own):
  // the fixture's `apps/web/runtime.ts` stamps every response and hands over its disk's driver,
  // which the boot registers as the default disk under the driver's name (31.0).
  test("the app's apps/web/runtime.ts middleware and storage run in development", async () => {
    const page = await dev.fetchDev('/pricing');
    expect(page.status).toBe(200);
    expect(page.headers.get('x-dev-runtime')).toBe('app');
    const served = page.headers.get('x-ultimate-build'); // BUILD_ID: reported must be served
    expect(`${dev.server.buildId} ${String(served)}`).toBe('stamped-7 stamped-7');
    expect(dev.server.runtime.storage.diskNames).toEqual(['local']);
  });

  // Under the embedded database a subscription took its snapshot and then heard nothing — PGlite
  // has no walsender and no boot installed a row observer — so every `--live` query in every
  // scaffolded app was dead in development. A real subscription on the real node, one repository
  // write through the fixture's own `database()` handle, one patch frame.
  test('a repository write in this process reaches a live subscriber as a patch', async () => {
    expect(dev.server.running.liveFeed).toBe('in-process');
    const registry = dev.server.running.liveRegistry;
    const bridge = dev.server.running.liveBridge;
    if (registry === null || bridge === null) expect.unreachable('the sync role has no bridge');
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: dev.server.buildId,
      serverBuildId: dev.server.buildId,
      actor: userActor({ id: 'u1' }),
    });
    const { frame } = await registry.subscribe({ socket, name: 'liveNotes', input: {} });
    expect(frame.type).toBe('snapshot');
    ws.frames.length = 0;

    const { db } = (await import(join(dev.root, 'apps/web/app/notes/entity.ts'))) as {
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
    const response = await dev.fetchDev(path, { headers: { accept: 'text/html' } });
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
