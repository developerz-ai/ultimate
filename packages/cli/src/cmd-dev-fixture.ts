// The app `x dev` boots in its tests, and the one place it is declared: every assertion that
// needs a booted app lives in `cmd-dev.test.ts`, because a process has ONE lifecycle — the second
// in-process boot is refused (X_LIFECYCLE_DRAINED) — and the coverage gate runs a package in one
// process. So the fixture is a module of its own, and that file keeps its line budget for tests.
//
// What the app declares, and what each declaration is here to prove:
//   app.config.ts               the root marker a real `x dev` cannot start without; `ai.mcp` by default
//   apps/web/mcp.ts             the app's own MCP endpoint, mounted by the web role
//   apps/web/runtime.ts         the app's middleware and disks, reaching a development process
//   .git/HEAD                   the fixture is its own repository — see the entry below
//   apps/web/app/hello/*        an SSR page with a component, edited on disk while `x dev` runs
//   apps/web/app/notes/*        a memory-backed entity and a live query, fed by the in-process bridge
//   apps/web/app/posts/*        an action, a policy and a query, mounted as HTTP routes
//   apps/web/site/pricing/*     a static page with its own stylesheet, under the CSP `x dev` sends
import { resetActions } from '@ultimat3/action';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetQueries } from '@ultimat3/query';
import type { Frame } from '@ultimat3/realtime';
import { decode } from '@ultimat3/realtime';
import type { WsLike } from '@ultimat3/realtime/server';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';

export const DEV_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-fixture', version: '1.4.0' }),

  // Its own repository, so the ignore walk stops HERE. The framework's root `.gitignore` lists
  // `packages/cli/.dev-fixture/`, and `devIgnore` honours every ancestor up to a `.git` — without
  // this marker the watcher admitted the fixture root and nothing under it, so no save in this
  // tree ever reached `rebuild`, and the reload path was booted by every run and exercised by none.
  '.git/HEAD': 'ref: refs/heads/main\n',

  // The root marker a real `x dev` cannot start without, and where `ai.mcp` is declared — by
  // default `{ expose: true }`, the switch the MCP mount reads. Where the endpoint mounts is its
  // own `defineAppMcp({ path })` below (default `/mcp`), never this file.
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'dev-fixture' });
`,

  // The app's own MCP endpoint, in the contract `app-mcp.ts` reads. `resolveToken` answering
  // `null` rejects every bearer, which is enough to prove the ROUTE is mounted (401, not 404).
  'apps/web/mcp.ts': `import { defineAppMcp } from '@ultimat3/mcp';
export const mcp = defineAppMcp({ include: 'exposed', resolveToken: () => null });
`,

  // The app's own middleware, in the contract `app-runtime.ts` reads: a header on every response
  // is the cheapest proof that the chain `x dev` composed is the app's and not only the replica's.
  // Its disks too: `x dev` built its own embedded disk and ignored this one until 22.4.
  'apps/web/runtime.ts': `import { defineStorage, localDriver } from '@ultimat3/storage';
const stamp = async (request, ctx, next) => {
  const response = await next(request, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-dev-runtime', 'app');
  return new Response(response.body, { status: response.status, headers });
};
const storage = defineStorage({
  disks: { appdisk: localDriver({ root: Bun.fileURLToPath(new URL('../../.app-disk', import.meta.url)) }) },
  default: 'appdisk',
});
export const runtime = { middleware: [stamp], storage };
`,

  // A memory-backed entity, so the fixture needs no migration: the row observer sits on
  // `database()`'s repo wrapper, the same seam a Postgres-backed repo writes through.
  'apps/web/app/notes/entity.ts': `import { database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
export const notes = entity('notes', { columns: { id: uuid().primaryKey(), title: text() } });
export const db = database({ notes }, { driver: memoryDriver() });
`,
  'apps/web/app/notes/live.ts': `import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import { db } from './entity';
export const liveNotes = query({
  input: t.object({}),
  policy: allow('public'),
  live: true,
  subscribes: ['notes'],
  sql: () =>
    from<{ id: string; title: string }>('notes', () => db.notes.where({}).all())
      .orderBy('id')
      .limit(50),
});
`,

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

  // A page with a body, on the surface an author edits all day. What the reload test rewrites: the
  // module must be imported again for the new body to be served, which `import()` alone never does.
  'apps/web/app/hello/page.tsx': `import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  budget: { js: '60kb' },
  meta: () => ({ title: 'Hello', description: 'A page that is edited while x dev runs' }),
});

export function Page() {
  return <p>generation one</p>;
}
`,

  // An ISR page whose body is a COMPONENT in another file — the shape every real page has. What the
  // component-reload test rewrites: the page module's own bytes never change, so only evicting what
  // imports the component re-evaluates it, and only clearing the ISR store stops the first render
  // from answering for the rest of the process (notificado.co, 2026-09-27).
  'apps/web/site/news/headline.tsx': `export function Headline() {
  return <h1>headline one</h1>;
}
`,

  'apps/web/site/news/page.tsx': `import { defineRoute } from '@ultimat3/render';
import { Headline } from './headline';

export const config = defineRoute({
  render: 'isr',
  revalidate: { ttl: '1h' },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: () => ({ title: 'News', description: 'A page whose component is edited while x dev runs' }),
});

export function Page() {
  return <main><Headline /></main>;
}
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

export const resetRegistries = (): void => {
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

/** A `WsLike` that keeps every frame the node sends, decoded — what a live assertion reads. */
export class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}
