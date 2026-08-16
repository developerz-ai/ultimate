# 12 — The two tracked apps

> Part of [`overview.md`](overview.md). Depends on: 01–07 (several findings here are call-site
> consequences of framework bugs those slices fix). Tier: apps.

`examples/dummy` is the reference app — every primitive, once, idiomatically. `dummy/social-media-clone`
is the deployed demo, built on every push to main. Both gate on their own `expectedRed` table in
`scripts/lib/gated-apps.ts`.

**The ratchet itself is sound**: `bun run scripts/reference-app-gate.ts --json` → exit 0, zero
findings, `examples/dummy 10/17, 7 red (7 pinned); dummy/social-media-clone 14/17, 3 red (3 pinned)`.
No pinned step is currently passing. The two defects in the gate are the missing suite floor
([`05-gate-and-scripts.md`](05-gate-and-scripts.md)) and the stale pin prose below.

## Critical

- `dummy/social-media-clone/packages/db/src/client.ts:30` — `export const driver = memoryDriver()`
  **unconditionally**. `database(entities, {driver})` prefers an explicit driver over
  `defaultDriver()` (`packages/entity/src/database.ts:79`), so `DATABASE_URL` can never select
  Postgres. Five containers from one image each get their own empty store: `migrate` creates tables
  nothing queries, `worker`'s seed is invisible to `web`, and every session and post is lost on
  restart — on a **public URL**. Line 28 says the opposite ("In production `DATABASE_URL` selects the
  Postgres driver"), as do `app.config.ts:19` and `README.md:9`. Fix: branch on `DATABASE_URL`. Same
  shape (no driver passed, so the default applies) at `examples/dummy/packages/db/src/client.ts:18` —
  verify that one resolves correctly rather than assuming.

- `examples/dummy/apps/web/shared/actor.ts:38` — `useActor()` reads `ctx.session`, declared in
  `CtxServices` (`shared/services.ts:87`) but **never registered** via `defineService`;
  `apps/web/api/index.ts` registers only `posts` and `orgs`. `installedServices()` builds the bag
  from registered factories only, so `ctx.session` is `undefined` and every `app/` route throws.
  `tsc -b` confirms: `packages/http/src/context.ts(152,3): RequestContext is missing … posts, orgs,
  session, channel`. This is one of the two errors leaking through project references, so it is
  load-bearing on the pin prose below.

- `examples/dummy/apps/web/app/posts/new/page.tsx:29` and `app/posts/[id]/page.tsx:129` — both native
  forms POST to `/_x/action/<kebab>`, which **nothing mounts**. Actions project to
  `POST /api/<resource>/<verb>` (`packages/action/src/naming.ts:56-67`); `x actions` prints
  `/api/posts/create` and `/api/comments/create`, matching `openapi.json`. `/posts/new` is
  `hydrate: 'never'`, so the form is the only path — the page cannot work.
  `site/pricing/page.tsx:40` gets it right via `derivePath`. Fix: use `derivePath` in both.

## High

| Site | Defect |
|---|---|
| `examples/dummy/apps/web/app/posts/jobs.ts:26` | `ctx.channel(...)` declared, registered nowhere; `notifySubscribers`' announce step throws every publish, retries 5×, dead-letters — and the mail loop after it never runs |
| `examples/dummy/apps/web/app/feed/page.tsx:26`, `app/posts/[id]/page.tsx:21`, `app/posts/new/page.tsx:15` | three authed routes declare no `policy:`, so `dev-render.ts:238` marks them `auth: 'public'` and `ssrHeaders` emits `s-maxage=30` with **no `vary: cookie`** — per-actor org HTML shared-cacheable across tenants for 30s |
| `examples/dummy/apps/web/app/layout.tsx:43` | the org switcher posts to `/_x/session/org`, which exists nowhere; switching org 404s on every `app/` page |
| `examples/dummy/apps/web/site/page.tsx:58`, `site/pricing/page.tsx:125` | CTAs link to `/signup`, absent from the 9-route table. `examples/dummy/CLAUDE.md` asserts `/signin\|/signup\|/signout` are mounted and contradicts itself elsewhere |
| `dummy/social-media-clone/apps/admin/app/admin/views.tsx:99` | admin toolbar buttons have no `onClick`, no enclosing form, on a `hydrate: 'never'` page; `invokeAdminAction`/`adminCreate`/`adminUpdate`/`adminDestroy` have **zero non-test callers**. Disproves `apps/admin/README.md:18-20` and `CLAUDE.md:109` |
| `dummy/social-media-clone/apps/web/app/friends/service.ts:115` | `unblockPerson` throws citing a framework gap that **closed**: `deleteWhere` exists (`packages/entity/src/query.ts:116,345`) and is already used at `examples/dummy/apps/web/app/posts/repo.ts:191`. Blocking is a one-way door |
| `dummy/social-media-clone/apps/web/app/friends/repo.ts:25` | `peopleByIds` caps at 100 while `screen.ts:57-61` passes up to 300 ids; `viewOf` returns `null` and the caller filters, so friendships silently vanish with no error |
| `dummy/social-media-clone/apps/web/app/messages/service.ts:45-60` | three awaited reads per conversation, bounded at 50 → ~152 statements per `/messages` render — the `X_N_PLUS_ONE_QUERY` shape the sibling `friends/screen.ts:41-43` explicitly avoids |
| `dummy/social-media-clone/packages/i18n/src/index.ts:28` | `useT()` has **zero callers**; all 28 rendering files use the untyped `t`, so a mistyped key renders `⟦key⟧` instead of failing the build — contradicting lines 2 and 25-27 |
| `dummy/social-media-clone/packages/mcp/src/index.ts:3` | imports `@social-media-clone/web/api/health`, a `packages/ → apps/` **upward edge** its own `CLAUDE.md:7` forbids, resolving only through the root tsconfig alias |
| `examples/dummy/packages/mcp/src/tools.ts:97-98` | `planQuote` hardcodes `daysRemaining: 15, daysInCycle: 30` while `upgradePlan` computes both from the real cycle — the quote disagrees with the charge on every day but one |

## Medium

**`examples/dummy`** — `site/offline/page.tsx:27`, `app/settings/page.tsx:36` and
`app/posts/new/page.tsx:21` all intend `noindex` and emit `index,follow`: one uses a top-level
`robots` key `RouteDefinition` does not have, two pass a string where `RobotsDirectives` is required
so `robotsContent` reads `.index` off a string. `app/settings/page.tsx:31` passes a `Policy` where a
`RouteGuard` is required, dropping the permission entirely.

**`dummy/social-media-clone`** —

| Site | Defect |
|---|---|
| `DOMAIN.md` | describes a `follows` entity, five actions, four jobs and a task that do not exist, with no "written before the build" disclaimer |
| `README.md:17-18` | claims render modes the manifest disproves |
| `CLAUDE.md:8-9` | says 2 pins where `gated-apps.ts` has 3 |
| `apps/web/app/posts/repo.ts:38-45` | reads a fixed first-200 users slice, so posts by user #201 vanish |
| `app/tasks/schedule.ts:39-44` | enqueues a job that throws unconditionally on Postgres — 24 dead-letters/day |
| `app/messages/action.ts:61-69` | up to 99 sequential non-atomic notification inserts on the request path |
| `app/tasks/repo.ts:96-100` | deletes 5,000 rows in one un-checkpointed attempt |
| `api/realtime.ts:24` | `installRealtimeTopics` never called, so every subscribe is denied while the manifest says realtime is on |
| `site/u/repo.ts:13` | renders suspended accounts |
| `apps/admin/app/admin/screen.ts:54,62,56` | `'—'`/`'yes'`/`'no'` not through `t()`, and `Intl.DateTimeFormat('en', …)` hardcodes the locale while `AdminActor.locale` is discarded (the `timeZone` half is correct) |
| `apps/admin/app/admin/repo.ts:141-149` | bypasses `decideOperation`, gating media data on `job:read` alone |
| `/admin/jobs` | no nav entry |

## The pin prose is stale, and one line of it is load-bearing

`scripts/lib/gated-apps.ts:34-48,61-65` — two pin **descriptions** state counts the current run
disproves:

| Pin | Prose says | Actual |
|---|---|---|
| `examples/dummy` typecheck | 137 errors, 1 leaking through project refs | **138** errors, **2** leaking — `packages/mcp/src/transport-stdio.ts:35` *and* `packages/http/src/context.ts:152` |
| `examples/dummy` budgets | 8 routes | **9** routes |

`gateFindings` compares step **names** only, so pin prose is never checked. The second leak is the
`session`/`channel` Critical above — so this is not cosmetic: the prose is hiding a real regression.
Fix: correct both descriptions, and consider hashing the prose against a re-derived count so it
cannot drift silently again (axiom 3).

## Consequences of framework fixes — re-check after other slices land

- [`11-deploy-ci.md`](11-deploy-ci.md) — both apps' `docker/Dockerfile` are dead (`COPY … bun.lock`
  with no app-root lockfile) and both `.dockerignore`s bake `.env.production` into the image.
- [`04-projection-contract.md`](04-projection-contract.md) — both apps' committed `openapi.json`
  carry the `nullable` defect and must be regenerated.
- [`03-tier45-bugs.md`](03-tier45-bugs.md) — `examples/dummy/apps/web/site/blog/[slug]/page.tsx:56,60`
  feeds `data.title` into `ld:`, which is the live trigger for the JSON-LD XSS.
- Several `budgets` pins may become closable once `X_BUDGET_UNMEASURED` is fixed — re-run the gate
  and shrink the ratchet with `--unpin` rather than leaving a pin that no longer describes anything.

## Verified fixed — do not re-report

Every 2026-08-12 app finding: the query client, the missing `orgId`, the `toCardPost` row shape, the
mail `{org}` slot, the hardcoded strings, both retry-unit bugs, the digest N+1, the phantom repo API,
the unused `flags`/`storage` imports, and the `boundaries` pin (now removed).

## Tests

- Each Critical gets an app-level test in its own app's suite; the form-path bug is caught by a test
  asserting every native `form action` in the app resolves to a mounted route.
- A test that every key in `CtxServices` has a registered factory — this is the general form of the
  `ctx.session` Critical and belongs in `@ultimat3/http`, not the app.
- `scripts/reference-app-gate.test.ts` — pin descriptions match a re-derived count.

## Done when

- All three Criticals fixed; `dummy/social-media-clone` runs on Postgres and survives a restart.
- Pin prose corrected and the ratchet shrunk for anything the framework fixes closed.
- `bun run scripts/reference-app-gate.ts` green with fewer pins than it has today.
