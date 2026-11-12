// `/_x` under `x dev`, end to end: `@ultimat3/admin`'s dashboard, mounted by a real boot of the
// fixture app (`cmd-dev-boot-fixture.ts`). The assertions read the panels' own payloads, so a CLI
// that grew a second copy of one would fail this file — and each tab answers, none a dead end.

import { describe, expect, test } from 'bun:test';
import { declareTags, invalidateTags, tag } from '@ultimat3/cache';
import { bootDevFixture } from './cmd-dev-boot-fixture';

const dev = bootDevFixture('.dev-panels-fixture');

describe('unit · x dev mounts the /_x dashboard over the app it booted', () => {
  test('/_x serves the dashboard shell, with a tab per mounted panel', async () => {
    const response = await dev.fetchDev('/_x');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const shell = await response.text();
    for (const key of dev.server.panels) expect(shell).toContain(`href="/_x/${key}"`);
    expect(dev.server.panels).toHaveLength(11);
  });

  test('/_x/routes?json=1 is the panel payload, naming the route the fixture registered', async () => {
    const payload = (await (await dev.fetchDev('/_x/routes?json=1')).json()) as {
      panel: string;
      ok: boolean;
      data: { routes: { path: string }[] };
    };
    expect(payload).toMatchObject({ panel: 'routes', ok: true });
    expect(payload.data.routes.map((route) => route.path)).toContain('/pricing');
  });

  test('/_x/services reports the roles and services this process actually booted', async () => {
    const payload = (await (await dev.fetchDev('/_x/services?json=1')).json()) as {
      ok: boolean;
      data: { roles: string[]; services: { db: { mode: string } }; reloads: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.roles).toEqual(['web', 'sync', 'worker', 'scheduler']);
    expect(payload.data.services.db.mode).toBe('embedded');
    expect(payload.data.reloads).toBe(0);
  });

  test('/_x/db reads the embedded Postgres and refuses a write statement', async () => {
    const read = (await (await dev.runSql('select 1 as n')).json()) as {
      ok: boolean;
      data: { result: { columns: string[]; rows: unknown[][] } | null; refused: string | null };
    };
    expect(read.ok).toBe(true);
    expect(read.data.refused).toBeNull();
    expect(read.data.result?.columns).toEqual(['n']);
    expect(read.data.result?.rows).toEqual([[1]]);

    const write = (await (await dev.runSql('delete from x_jobs')).json()) as {
      data: { result: unknown; refused: string | null };
    };
    // Asserts the two halves an operator needs, not the prose around them: WHICH word made it a
    // write, and the one command that runs it anyway. Matching a phrase like "read-only" passed
    // for a refusal that named neither — and it broke the moment the panel stopped calling a
    // syntax error a permissions problem.
    expect(write.data.refused).toContain('"delete"');
    // `x db psql --write` was named here until 2026-10-01; no such command exists (`x db --help`).
    expect(write.data.refused).toContain('psql "$DATABASE_URL"');
    expect(write.data.refused).not.toContain('x db psql');
    expect(write.data.result).toBeNull();
  });

  test('/_x/manifest is the loaded app, diffed against the committed file', async () => {
    const payload = (await (await dev.fetchDev('/_x/manifest?json=1')).json()) as {
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
    expect(emitted.routes.map((route) => route.url)).toEqual(['/hello', '/news', '/pricing']);
    // The fixture never ran `x manifest`, so every key reads as added rather than as changed.
    expect(payload.data.manifest.committed).toBeNull();
    expect(payload.data.drifted).toBe(true);
    expect(payload.data.added).toContain('app');
  });

  test('/_x/timeline is the request this process just served, not a refusal', async () => {
    await dev.fetchDev('/api/posts/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: 'traced' }),
    });

    const payload = (await (await dev.fetchDev('/_x/timeline?json=1')).json()) as {
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

  test("/_x/policy is the app's real matrix: one column per declared role", async () => {
    const payload = (await (await dev.fetchDev('/_x/policy?json=1')).json()) as {
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

    const response = await dev.fetchDev('/_x/cache?json=1');
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
    for (const key of dev.server.panels) {
      const body = (await (await dev.fetchDev(`/_x/${key}?json=1`)).json()) as { ok: boolean };
      if (!body.ok) refused.push(key);
    }
    // Four of these eleven refused before this wiring: timeline, cache and policy had no source
    // at all, and the refusal threw past the panels' own degradation on the way out.
    expect(refused).toEqual([]);
  });

  test('/_x/live names the live query, and says its subscriber source is unwired rather than empty', async () => {
    const payload = (await (await dev.fetchDev('/_x/live?json=1')).json()) as {
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
    const response = await dev.fetchDev('/_x/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; cause: string; fix: string };
    expect(body.code).toBe('X_ROUTE_NOT_FOUND');
    expect(body.cause).toContain('/_x/nope');
    expect(body.fix.length).toBeGreaterThan(0);
  });
});
