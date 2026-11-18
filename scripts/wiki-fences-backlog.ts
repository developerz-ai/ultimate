// The ratchet under `scripts/wiki-fences.ts`: every fenced `ts`/`tsx` example on a `wiki/` page
// that does not typecheck today, keyed by FENCE — `<page>: <its first code line>` — with how many
// fences of that page open with that line. A row may FALL and may never rise — a new example must
// compile from the day it is written, and the ones that do not get retired over time.
//
// Measured when this shipped (2026-10-06): 182 failing across 45 pages. Most are the
// fragments `scripts/readme-fences-backlog.ts` describes for package READMEs — an identifier the
// prose around the block defines, an app-level import (`@app/db`, `./entity`) that resolves in
// an app and not here, a signature with its arguments elided. Keyed on the first code line for
// that file's reason: it moves only when the example does, where a line number moves on every
// paragraph edit; a per-page count let a fixed example be swapped for a new broken one unseen.
//
// why: the table is new in sweep 11 and opens with the wiki's whole measured debt at once — no
// wiki fence was ever compiled before it, so every count is a first measurement, not a raise.
// why: re-keyed per fence in plan 101 sweep 11c — the same 182 failing fences at 178 sites;
// `pin-raises` reads a wholly re-keyed table against its old total.
//
// A row with a `// why:` is a fence that cannot compile as written: it is a fragment by design, or
// it imports the app's own files. A row without one can be repaired and has not been yet.
//
// Shrink it with `bun run scripts/wiki-fences.ts --pin`, which lowers a row and refuses to
// raise one. Adding or raising a row is a hand edit, on purpose, in a review.

export const WIKI_FENCE_BACKLOG: Readonly<Record<string, number>> = {
  // why: imports `@app/db`: the app's own files, which a one-file fixture cannot resolve
  'Admin-Dashboard: // apps/admin/app/admin/admin.ts — the whole dashboard': 1,
  // why: object members shown without their call, opening `mcp:`; they do not parse alone
  "Admin-Dashboard: mcp: { expose: true, description: 'Publish a draft post' },": 1,
  // why: object members shown without their call, opening `resources:`; they do not parse
  // alone
  'Admin-Dashboard: resources: { posts: { count: true } },': 1,
  // why: object members shown without their call, opening `budget:`; they do not parse alone
  'Agents: budget: {': 1,
  // why: imports `./support`: the app's own files, which a one-file fixture cannot resolve
  "Agents: import { agentJob } from '@ultimat3/ai';": 1,
  // why: imports `./triage`: the app's own files, which a one-file fixture cannot resolve
  "Agents: import { database, entity, text, timestamp, uuid } from '@ultimat3/entity';": 1,
  // why: imports `./support`: the app's own files, which a one-file fixture cannot resolve
  "Agents: import { t } from '@ultimat3/action';": 2,
  // why: object members shown without their call, opening `onTurn:`; they do not parse alone
  'Agents: onTurn: ({ turn, maxTurns, model, toolCalls, stopReason, usage, cost }) => {': 1,
  // why: imports `../../shared/base/tenant-entity`: the app's own files, which a one-file
  // fixture cannot resolve
  'Building-Your-Own-Base: // apps/web/app/invoices/entity.ts': 1,
  // why: imports `../entity`, `../policies`, `../repo`: the app's own files, which a one-file
  // fixture cannot resolve
  'Client-Data: // app/posts/actions/rename-post.ts': 1,
  // why: imports `./entity`, `./policies`, `./repo`: the app's own files, which a one-file
  // fixture cannot resolve
  'Client-Data: // app/posts/queries.ts': 1,
  // why: imports `../../shared/browser-client`: the app's own files, which a one-file fixture
  // cannot resolve
  'Client-Data: // app/posts/rename.island.tsx': 1,
  // why: imports `../api`: the app's own files, which a one-file fixture cannot resolve
  'Client-Data: // shared/browser-client.ts — type-only import of the api, so no server code reaches the island': 1,
  // why: elides code with `…`, which does not parse
  "Client-Navigation: export const config = defineRoute({ render: 'ssr', …, navigation: 'prefetch' });": 1,
  // why: object members shown without their call, opening `navigation:`; they do not parse
  // alone
  "Client-Navigation: navigation: { speculation: { prefetch: 'moderate', exclude: ['/blog/borrador-*'] } },": 1,
  // why: object members shown without their call, opening `islands:`; they do not parse alone
  'Configuration: islands: { sharedChunks: true },': 1,
  // why: object members shown without their call, opening `mail:`; they do not parse alone
  'Configuration: mail: { retainMime: { maxBytes: 262_144 } },': 1,
  // why: object members shown without their call, opening `navigation:`; they do not parse
  // alone
  "Configuration: navigation: { client: ['app'], speculation: { prefetch: 'moderate', exclude: [] } },": 1,
  // why: object members shown without their call, opening `pwa:`; they do not parse alone
  'Configuration: pwa: {': 1,
  // why: imports `./entity`, `@myapp/db`: the app's own files, which a one-file fixture cannot
  // resolve
  'Entities-And-Migrations: // apps/web/app/widget/repo.ts — as `x g entity widget` writes it': 1,
  // why: object members shown without their call, opening `embed:`; they do not parse alone
  "Entities-And-Migrations: embed: { field: 'body', model: 'text-embedding-3-large' },": 1,
  // why: imports `../app/posts/actions`, `../app/posts/jobs`, `../app/posts/live`,
  // `../app/posts/mutator`, `./tasks`: the app's own files, which a one-file fixture cannot
  // resolve
  'Getting-Started: // apps/web/api/index.ts': 1,
  // why: imports `../../../shared/client`, `@myapp/domain`: the app's own files, which a
  // one-file fixture cannot resolve
  'Getting-Started: // apps/web/app/posts/ui/publish-button.tsx': 1,
  // why: imports `../api`: the app's own files, which a one-file fixture cannot resolve
  'Getting-Started: // apps/web/shared/client.ts': 1,
  // why: the `handle` method shown without its `action({ … })`
  'Jobs-And-Workflows: async handle({ input, ctx }) {': 1,
  // why: object members shown without their call, opening `idempotencyKey:`; they do not parse
  // alone
  'Jobs-And-Workflows: idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type': 1,
  // why: object members shown without their call, opening `run:`; they do not parse alone
  'Jobs-And-Workflows: run: async ({ input, ctx, step }) => {': 1,
  // why: object members shown without their call, opening `mcp:`; they do not parse alone
  'MCP-And-AI: mcp: {': 1,
  // why: object members shown without their call, opening `mcp:`; they do not parse alone
  "MCP-And-AI: mcp: { expose: true, description: 'Publish a draft post' },": 1,
  // why: object members shown without their call, opening `mail:`; they do not parse alone
  'Mail: // app.config.ts': 1,
  // why: imports `./schema`: the app's own files, which a one-file fixture cannot resolve
  "Migrating-An-Existing-App: import { backfill } from '@ultimat3/jobs';": 1,
  // why: a signature listing for `backfill<Row>({ … })`, not a call
  'Migrations-And-Backfills: backfill<Row>({': 1,
  // why: object members shown without their call, opening `total:`; they do not parse alone
  "Money: total: money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),": 1,
  // why: a function body shown alone: its top-level `return` does not parse
  'N-Plus-One-Detection: // one indexed lookup per search field beats one unindexed OR across all of them': 1,
  // why: elides code with `…`, which does not parse
  'PWA-And-Offline: // app.config.ts — every member optional; text is a string or one per locale': 1,
  // why: object members shown without their call, opening `pwa:`; they do not parse alone
  'PWA-And-Offline: // app.config.ts — omitting `offline.fallback` is a compile error': 1,
  // why: object members shown without their call, opening `pwa:`; they do not parse alone
  'PWA-And-Offline: // app.config.ts: the two capabilities an app can switch on, both booleans': 1,
  // why: imports `../api`: the app's own files, which a one-file fixture cannot resolve
  "Queries-And-Live-Queries: // apps/web/shared/client.ts — the app's one place for both": 1,
  // why: imports `../posts/entity`, `./channel-ref`, `./policies`: the app's own files, which
  // a one-file fixture cannot resolve
  'Realtime: // app/feed/channels.ts — the SERVER half, on the same ref. Registers on import.': 1,
  // why: imports `./channel-ref`: the app's own files, which a one-file fixture cannot resolve
  'Realtime: // in an island: the ref, never the server half (which would bundle the entity and its driver)': 1,
  // why: the `load:` member shown without the call around it
  "Routes-And-Render-Modes: import { setRedirect } from '@ultimat3/http';": 1,
  // why: object members shown without their call, opening `meta:`; their types come from that
  // call
  'Routes-And-Render-Modes: meta: ({ post }) => ({ /* ... */ ld: ld.Article(post) })': 1,
  // why: object members shown without their call, opening `seo:`; they do not parse alone
  "SEO: seo: { sitemap: { extra: ['/verificar', '/estado'], lastmod: 'git' } },": 1,
  // why: the `prompt:` member shown without the call around it
  'Scraping: const waitForAnswer = eventPrompt({ timeout: 300_000 });': 1,
  // why: object members shown without their call, opening `expect:`; they do not parse alone
  'Scraping: expect: { minRows: 1, maxDrop: 0.5, window: 7 },': 1,
  // why: object members shown without their call, opening `recover:`; their types come from
  // that call
  'Scraping: recover: async ({ page, failure, attempt }) => { /* return true to re-run the body once */ }': 1,
  // why: object members shown without their call, opening `secrets:`; they do not parse alone
  "Scraping: secrets: ['SHOP_PASSWORD'],": 1,
  // why: imports `@app/db`: the app's own files, which a one-file fixture cannot resolve
  'Testing: // scripts/test-setup.ts': 1,
  // why: imports `./page`: the app's own files, which a one-file fixture cannot resolve
  "Testing: import { expect, renderRoute, renderView, unitTest } from '@ultimat3/testing';": 1,
  // why: object members shown without their call, opening `invariants:`; they do not parse
  // alone
  'Tutorial-01-First-App: invariants: (c) => [': 1,
  // why: imports `../app/todo/actions/archive-todo`, `../app/todo/actions/create-todo`,
  // `../app/todo/jobs/reindex-todo`, `../app/todo/live/todo-list`, `./health`: the app's own
  // files, which a one-file fixture cannot resolve
  'Tutorial-02-First-Feature: // apps/web/api/index.ts, in an app made with `x new --no-example` — importing it IS the boot': 1,
  // why: elides code with `…`, which does not parse
  "Tutorial-02-First-Feature: export const CreateTodoInput = todo.$view(['title', 'price']);": 1,
  // why: imports `@myapp/web/app/todo/entity`: the app's own files, which a one-file fixture
  // cannot resolve
  "Tutorial-02-First-Feature: export { todo } from '@myapp/web/app/todo/entity';": 1,
  // why: imports `@myapp/db`: the app's own files, which a one-file fixture cannot resolve
  'Tutorial-03-Auth-And-Admin: // apps/admin/app/admin/admin.ts': 1,
  // why: imports `@postly/db`, `@postly/web/api`: the app's own files, which a one-file
  // fixture cannot resolve
  "Tutorial-03-Auth-And-Admin: import { db, LIVE_RUN_STATUSES, runEvents, runs } from '@postly/db';": 1,
  // why: imports `./auth`: the app's own files, which a one-file fixture cannot resolve
  "Tutorial-03-Auth-And-Admin: import { logout, signOutHeaders } from '@ultimat3/auth';": 1,
  // why: object members shown without their call, opening `cache:`; they do not parse alone
  'Tutorial-06-Growing-Up: // app.config.ts': 1,
  // why: object members shown without their call, opening `policy:`; their types come from
  // that call
  'Upgrading: // before — answered ALLOWED, and admitsAnonymous() agreed, so http did not 401 first': 1,
  // why: elides code with `…`, which does not parse
  'Upgrading: // before — compiles, and is circular: the factory that BUILDS ctx.posts': 1,
  // why: one `case` arm shown without its `switch`
  "Upgrading: case 'missing-check':": 1,
};
