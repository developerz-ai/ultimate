// `x dev` end to end, against a real app on disk: PGlite boots, the jobs table is created, the
// app's modules register, and the actions those modules declared answer over the same HTTP
// pipeline production runs. A fixture that stubbed any of that would prove nothing — the bug this
// replaces was a dev server that served `/_x` and 404'd every route the app actually had.
//
// `/_x` here is `@ultimat3/admin`'s dashboard, mounted. The assertions below read the panels'
// own payloads, so a CLI that grew a second copy of one would fail this file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { declareTags, invalidateTags, tag } from '@ultimat3/cache';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { cspHashSource } from '@ultimat3/http';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';
import type { DevServer } from './cmd-dev';
import { devCommand, startDev } from './cmd-dev';
import { CliNotImplementedError } from './errors';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve through the same tsconfig
// paths the framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.dev-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-fixture', version: '1.4.0' }),

  'apps/web/app/posts/policy.ts': `import { allow, can, definePermissions, defineRoles } from '@ultimat3/policy';
export const permissions = definePermissions(['post:publish'] as const);
export const roles = defineRoles({
  author: { grants: ['post:publish'] },
  reader: { grants: [] },
});
export const canPostWrite = can('post:publish');
export const anyone = allow();
`,

  'apps/web/app/posts/actions.ts': `import { action, t } from '@ultimat3/action';
import { anyone, canPostWrite } from './policy';

export const publishPost = action({
  input: t.object({ id: t.uuid }),
  output: t.object({ id: t.uuid }),
  policy: canPostWrite,
  async handle({ input }) {
    return { id: input.id };
  },
});

export const echoPost = action({
  input: t.object({ word: t.string }),
  output: t.object({ word: t.string }),
  policy: anyone,
  async handle({ input }) {
    return { word: input.word };
  },
});
`,

  // A stylesheet the page imports, because that import is what registers it — and the document's
  // inline `<style>` is what the CSP has to name. Without one this file served no styled page and
  // could not have caught the policy that blanked every deployed app.
  'apps/web/site/pricing/page.module.scss': `.price { color: #123456; }
`,

  'apps/web/site/pricing/page.tsx': `import { defineRoute } from '@ultimat3/render';
import './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Pricing', description: 'What it costs' }),
});
`,
};

const resetRegistries = (): void => {
  resetActions();
  resetQueries();
  clearEntities();
  clearRoutes();
  resetJobs();
  resetTasks();
  clearPermissions();
  clearRoles();
  resetAppLoad();
};

let server: DevServer;

/**
 * Booting embedded Postgres, the queue and the HTTP role is seconds of real work, and bun's
 * default hook budget is 5s — close enough to this boot that a loaded machine decided whether the
 * file passed. Every timeout in this file is explicit and generous for that reason: a hang should
 * be reported as a hang, never as a boot that was 300ms slower than the runner's default.
 */
const BOOT_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetRegistries();
  // Port 0 asks the OS for a free one, so this suite never collides with a running `x dev`.
  server = await startDev({ root: ROOT, port: 0, env: {}, roles: ['web', 'worker', 'scheduler'] });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await rm(ROOT, { recursive: true, force: true });
  resetRegistries();
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
    expect(server.roles).toEqual(['web', 'worker', 'scheduler']);
    expect(server.running.worker).not.toBeNull();
    expect(server.running.scheduler).not.toBeNull();
    expect(server.running.syncUrl).toBeNull();
    expect(server.findings).toEqual([]);
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
    expect(payload.data.roles).toEqual(['web', 'worker', 'scheduler']);
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
    expect(write.data.refused).toContain('read-only');
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

  test('/_x/live says there is no sync node rather than claiming no subscribers', async () => {
    const payload = (await (await fetchDev('/_x/live?json=1')).json()) as {
      ok: boolean;
      data: { subscribers: unknown[]; note: string | null };
    };
    // `subscribers` is the one source still unwired — `@ultimat3/realtime` records no matcher
    // trace, and that trace is the panel's whole question. The panel degrades to its note; an
    // empty list with no note would read as "nobody is subscribed", which is a different claim.
    expect(payload.ok).toBe(true);
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
