# @ultimat3/admin — history

The reasoning moved out of [`packages/admin/CLAUDE.md`](../../packages/admin/CLAUDE.md) (plan 101,
slice 14, `As of 2026-10-01`), verbatim. A record of why, never a current fact: the rules that
still hold are in that file, and where the two disagree it wins.

## Rules, as they were written

- **The subject carries the tenant and the loaded row.** `AdminActor.orgId` reaches `policyActor` and `AdminSubject.row` reaches `evaluate`, so an org-scoped or ownership rule can fire at all. It could not: every admin decision was evaluated with `actor.orgId === undefined` and `row === null`, so a role-only rule allowed and the coarse `admin:read` + `<entity>:read` pair was the only gate on a row — while `adminList`/`adminSearch` add no tenant predicate of their own. `adminDetail`, `adminUpdate` and `adminDestroy` load the row BEFORE the guard, the shape `packages/action/src/invoke.ts` uses; `undefined` means "not loaded" and is left off the subject, `null` means "looked and found none" and fails a row rule closed. Pinned in `policy-bridge.test.ts`, which asserts the SUBJECT a policy receives — `staticAuthz` is a grant-list stub and no suite driving it can see any of this.
- **The MCP caller is the ambient actor for the whole call.** `mcp.ts` wraps `callAdminTool` in a child context (or a fresh root one over stdio, where there is no surrounding request), the same rule `@ultimat3/mcp`'s `app-tool.ts` states. `AdminApp.ctx()` builds a plain `CrudCtx` and touches nothing async-local, so everything deriving from `tryUseContext()` — entity's tenant guard, the query cache authority, the jit-preload store — read the TRANSPORT's actor: an agent token authorized as agent X while the repo reads ran as the cookie user's tenant, and over stdio `actorTenant` was `undefined` and `assertRowTenant` a no-op. Pinned in `mcp-context.test.ts`. **And the caller's TENANT rides both hops** — `resolveToken` mints the `Actor`, `adminActorOf` rebuilds the `AdminActor` from it, and each dropped `orgId`, so every `AdminAuthz` decision over `POST /mcp` was made with `actor.orgId === undefined` while the same app's UI path saw the real org. Pinned in `mcp-tenant.test.ts`, which asserts the org an authz decision RECEIVES, over `route.handle` — the catalog filter and the call both.
- **One `AdminAction.name`, one handler.** The name is the MCP tool name (`admin.action.<name>`), the default label key, AND the key `callAdminTool` resolves a handler by — three addresses, one string. Two actions sharing it is `X_ADMIN_ACTION_DUPLICATE` at `defineAdmin` time (`admin.ts`, `mcp.test.ts`), not at the first agent call: `.find()` on a name dispatches to whichever resource came first, which is a call that SUCCEEDS against the wrong action and reports nothing. Refused at declaration rather than in `adminMcp()` because an app that renders the dashboard and never wires MCP has the same two broken label keys and the same ambiguous dispatch. The framework's own examples already qualify the name with the entity (`post.publish`) — the `fix:` line is that convention, made into the instruction. The same object attached through both `actions:` and `resources[e].actions` is one action, not two: identity, not name, is what "already seen" means.
- **`decideAll([])` DENIES.** `permissions[length - 1] ?? ''` fell through to `allowed('')`, so a
  declared-but-empty gate opened for every actor, anonymous included, and named no permission at
  all. `visibleNav` hands an author's `item.permissions` straight to it, so `permissions: []` on a
  nav item was that gate. `pages.ts` already refuses an empty PAGE list at declaration
  (`X_ADMIN_PAGE_UNGUARDED`); this is the same rule at the seam every surface shares, which is
  where the ones that never pass through `defineAdmin` are decided. Reason
  `admin.policy.none-declared`.
- **Two resources may not claim one `path:`** — `assertUniqueResourcePaths` in `admin.ts`, refused
  at `defineAdmin` with `X_ADMIN_PAGE_PATH_INVALID` (`subject: 'resource'`). `adminRouteFor`
  resolves by `.find()`, so a duplicate produced EIGHT routes over FOUR paths and the second
  resource's four screens were unreachable, silently, with the dashboard rendering. Identical
  argument to the duplicate action NAME one line below it and to `pages.ts`'s shadow check — the
  same `taken` set, one step earlier. **A currently-booting app with a duplicate path now refuses
  at boot.**
- **The audit diff is TOTAL over every value a row holds.** `same()` compared with
  `JSON.stringify`, which THROWS on a bigint — and `money()` puts one on the row
  (`widget-value.ts`), so every update of a money-bearing row raised, AFTER `repo.update()` had
  committed: the write landed, the caller got an uncoded `TypeError`, and the log stayed empty.
  `canonicalJson` from `@ultimat3/core`, the same answer `packages/manifest/src/diff-routes.ts`
  gives to the same question. `crud.test.ts`'s fixture entity carries a `money()` column and its
  repo CLONES on read, because two reads of one row are two objects and a shared reference
  short-circuits the comparison the diff exists to make.
- **A repo that THROWS leaves a `failed` entry.** `AuditOutcome` declared the member and `crud.ts`
  emitted it in exactly one place — `invalid()`, for a validation issue — so a constraint
  violation, a statement that timed out after committing and a dropped connection each left nothing
  at all. `auditedWrite` wraps the three repo writes: try, record, re-throw UNCHANGED. A mutation
  cannot append BEFORE the call the way `search.ts` does for a read; that would record a write
  which may never have happened. The reason is a key (`admin.audit.write-failed`), never anything
  read off the thrown value.
- **Nothing is read off a caught value in `action-gate.ts`, and the append runs first.** It built an
  `AdminDecision` whose `trace` was `String(error)` — and a `catch` binding is annotated by nobody,
  so `Object.create(null)` raised `TypeError: No default value` from inside the block that owed the
  auditor an entry: measured, ZERO entries and the caller received the TypeError. The decision
  object was DEAD anyway (only its `reason` was ever read; `append` takes no trace), so there is no
  destination for a rendered value and `renderThrowable` is not needed either.
- **`decideAll`'s and `/_x`'s record indexing is `Object.hasOwn` / a `Map`, never a bare index.**
  `ADMIN_PERMISSION_SPEC[permission]` consulted the PROTOTYPE CHAIN, so a polluted
  `Object.prototype` gave any granted permission an `implies` the table never declared — and
  `expandPermissions` walks it. `panel-cache.ts`, `panel-routes.ts` and `panel-policy.ts` counted
  into plain objects, where `__proto__` reads a prototype (so `?? 0` never fires) and WRITES through
  the setter, dropping the row: the policy matrix reported a permission unreachable while an actor
  held it. `Map` + `Object.fromEntries`, which DEFINES each key.

## Moved 2026-10-01, plan 101 slice 15 (room for the slice-15 rules)

- **A `/_x` source reads a registry through its DESCRIPTOR TYPE, never as an untyped bag.** `import type { RouteDescriptor }` beside the dynamic `import()` — the type is erased, so /_x still costs the production graph nothing, and a renamed descriptor field becomes a typecheck failure in `dev/data.ts` naming the field. The bag was defended here as tolerance and bought three panels that were wrong for every row and could not go red: `route['render']`, `route['budget']`, `route['revalidate']`, `job['idempotencyKey']` and `entity['drift']` are names no descriptor has ever published, so a read answered `undefined`, took the fallback, and shipped the fallback as a fact — every route `stream` with no budget and no tag, every job non-idempotent, every schema drift-free. `dev/published-keys.test.ts` is the runtime half a type cannot answer: it walks what the real registries EMIT, so a field the type declares and the projection never writes is a red test.
- **The timeline panel renders the detector's verdicts, it does not re-derive them.** `repeatedSql` (`dev/panel-timeline.ts`) is a measurement over the trace this panel recorded — every SQL text seen twice. `nPlusOne` is the verdict: `x dev`'s statement ledger, read through `DevSources.statementLoops()` and scoped to the selected request, in the ledger's own order. A second count here would be blind to the `expectedQueryLoop` above and to statement attribution (`members.findById`, not raw SQL text), and would disagree with the `fix:` an author actually pastes. No detector wired → `null`, never `[]`: "nobody counted" is not "this request was clean".
- **`dev/panel-db.ts`'s `sanitize` decides "did they type a statement", not "is it safe".** It blanks every opaque span in ONE left-to-right pass — `'…'`, `"…"`, `$tag$…$tag$` and both comment forms in a single alternation, because each form can contain another's opener — so `-- still typing` reads as an empty box. It used to feed a write-keyword scan in this file and that scan is gone; **do not cite it as a security property**. It once said an unterminated quote "leaves the rest visible — the guard fails closed": true of the scan it fed, meaningless now, and it never covered `$tag$` or slash-star, whose surviving character is `$` or `/`.
- **`assertReadOnly` answers a VERDICT carrying the runnable string, and the panel executes THAT.**
  `assertReadOnlyQuery` documents that what it returns is what the caller must execute — every
  check ran on a stripped form and the return is the reconciled one — and `panel-db.ts` discarded
  it and ran the textarea's bytes. Benign only for as long as `verbatim()` normalises nothing more
  than a trailing `;`, which is a promise no other file is keeping; `@ultimat3/mcp`'s own
  `dev-server.ts` honours the contract, and a `string | null` return here made it impossible to.
  `ReadOnlyVerdict` is exported from `@ultimat3/admin/dev` beside it.
- **One read-only SQL guard, and it is `@ultimat3/mcp`'s — the whole verdict, with nothing held back.** `dev/panel-db.ts` calls `assertReadOnlyQuery` (tier 5 → tier 4, already a dependency) rather than keeping a second keyword scan: that guard also refuses a batch, a call into the `pg_read_*`/`pg_advisory_*`/`pg_sleep`/`set_config` families, `FOR UPDATE`, and a delimiter that never closes in all five forms (`'`, `E'`, `"`, `$tag$`, slash-star). A local unterminated-delimiter refusal lived here for one revision and was **deleted**: it tested for a surviving `'`/`"`, so it covered three of the five and called a dollar-quoted body "a quote" — one failure mode, two explanations, and a second detector for a property the guard below already tests. What stays local is the emptiness test and the **way out**: `@ultimat3/mcp` tells its caller to expose an action, which a developer at `/_x` cannot act on. The panel says "Fix the statement, or — if it is meant to write — run it in your own client", conditional on purpose: a write client grants writes, it does not close a delimiter, and the write flag used to be printed as *the* fix for a syntax error. (It also named a CLI subcommand that never shipped; slice 16 replaced it with `psql "$DATABASE_URL"`.)

## Slice 15 — detail, form, actions, audit (2026-10-01)

- **Zero JavaScript, still.** Slice 15 said selection, the batch bar and action forms "are
  islands". None shipped: every one of them works as a native form — a row checkbox joins the
  bar's form through its `form` attribute, "all matching" is a radio whose meaning is the list's
  own URL, an action's form is a page at `<row>?action=<name>`, and a confirmation is a server
  round trip. What an island would have bought — ticking every row with one click, an inline
  confirm — is a convenience over a working page, measured at 0 bytes today (`hydrate: 'never'`,
  `islands: []` on every admin route) and left for when someone asks for it.
- **The audit LOG is the store; a SINK is a copy.** The plan named "a Postgres `AuditSink`". A
  sink is write-only by its interface, and the history card and `entries()` must READ — so the
  durable thing is an `AuditLog` (`postgresAuditLog()`), whose `entries()` became async (a table is
  not this process) and keyset-paged (`before`), and which gained `atomic(run)` so a write and its
  entry commit together. `AuditSink` stays what it was: where a copy goes.
- **No `appendOnly`.** Plan 102 slice 04 has not landed in this tree, so `x_admin_audit` is a plain
  framework table; "append-only" is `audit-pg.ts` issuing an insert and a select and nothing else.
- **An allowed read is not persisted by default.** One insert per list page and per row opened is
  a write on every GET; a refused read is an event and is always written. `reads: true` opts in.
- **A row action lands on its row**, not on the list: the new state and the entry the action just
  wrote are both on that page.
- **`when` reads every column but a sealed one.** A `sensitive` column (an e-mail) is a
  legitimate thing to decide on and is never rendered by the decision; a sealed one is never read.
- **"All matching" is keyset by id, ascending.** A batch whose rows stay in the filter after it
  ran them (suspending users under a "role = member" filter) must still make progress, so the
  continuation is the last id reached and never "the first N again".
- **A write's result is checked against `rows`.** A create could name a row outside the actor's
  own scope and an update could move one out of it; reads were scoped and writes were not.

## Moved 2026-10-01, plan 101 slice 16 (room for the jobs-dashboard rules)

- **One owner of `globalThis.React`, and it is `@ultimat3/ui`'s.** `inert-jsx.ts` keeps the walkers (`nodesOf`, `shallowNodesOf`, `renderNodes`, `renderHtml`) and delegates install/restore to `probe`/`unprobe` from `@ultimat3/ui/jsx-probe` — tier 5 → tier 4, downward, no declared edge needed. It kept its own `depth`/`saved` pair until 2026-08-22 and two counters over one property restore in the wrong order: admin installs (saving the real binding), ui installs (saving ADMIN's factory), admin restores, ui restores admin's factory back over the top. `bun test` seats both packages in one process, so the interleave is reachable; `inert-jsx.test.ts` drives it in both orders.
- **A `/_x` panel orders by CODE UNIT, never `localeCompare`.** `dev/panel-routes.ts` sorted its
  rows with it, and with no locale argument `localeCompare` answers from the runtime's ICU default
  locale and collation version — so the same route table reads in a different order on a
  developer's machine than in the container the same build runs in, and a screenshot of one does
  not match the other. `(a < b ? -1 : a > b ? 1 : 0)`, inlined: `@ultimat3/render`'s `byCodeUnit`
  is package-internal, and a comparator is not worth widening a barrel for.
- **The locale picker reads `registeredLocales()`, not a bundled list.** It was
  `['en','es','de','fr','pt','ja']`, one line under a comment forbidding exactly that for IANA
  zones: an app registering `it` could not pick it, and an app with only `en` was offered five
  locales it renders `⟦key⟧` for. No fallback — an app with no catalog has no locale to offer, and
  inventing one is the admin declaring what the app did not.

## Slice 16 — the jobs dashboard (2026-10-01)

- **Resources, not screens.** The plan's ten screens are four ordinary resources and one overview.
  A resource over a `repo:` already had a list with filters and scope tabs, a detail page, the
  batch bar, row actions with `when`, the audit trail and MCP tools — writing jobs screens beside
  that would have been a second admin. The surfaces are hand-built `AdminEntity` values (`x_` is
  the framework's prefix), never `entity()`, which would have put four tables in the app's schema.
- **One read vocabulary: `job:read`.** The plan said `job:list`; the admin already declared
  `job:read` for `/admin/jobs` and the scaffold's role grants it. The four resources share it
  through the new `permission` noun instead of `x_jobs:read`, `x_job_queues:read`, … A role map
  grants a subject once.
- **No counts on the state tabs.** `stats()` is per queue and fleet-wide, so a tab count for an
  org-scoped operator would have been every tenant's. The counts are the overview's tiles, shown
  to a platform operator only; each tile links to its tab.
- **"All matching" is the store's bulk verb.** A walk of up to 1,000 rows through the button's
  gate would read and decide each one; `requeueMany` / `promoteMany` / `removeMany` do it in one
  statement with their own bound. `matching` on an `AdminAction` is the mechanism, usable by any
  store with a bulk verb; the per-row path stays for checked rows.
- **The fleet is a platform operator's.** Queues, tasks and workers have no tenant; an org-scoped
  operator pausing the shared queue would pause every org. Their row scope matches nothing for an
  actor with an `orgId` (`is-null` on the key), so a forged post finds no row.
- **A refresh, not a feed.** The overview is a plain read with a declared 30 s
  `<meta http-equiv="refresh">` — no socket, no SSE, no island, 0 bytes of JavaScript.
- **Found on the way:** an action with no `when` ran on a row outside the actor's `rows` (the row
  scope only stopped actions that declared one); an action's input labels sat under its own label
  key, which no JSON catalog can hold; `roleAuthz` did not apply `admin:destroy ⇒ admin:write`.

## Moved 2026-10-06, plan 101 sweep 10e (room for the scope and home-count rules)

- **One bridge per foreign package.** `policy-bridge.ts` is the only file calling `evaluate`/`definePermissions`; `route-config.ts` the only one calling `defineRoute`/`registerMountedRoutes`; `mcp.ts` the only one calling `defineAppMcp`; `dev/data.ts` the only one importing introspection (dynamically — `/_x` must stay out of the production graph). Source only: a **test** declares the permissions its own `can()` fixtures use, and calls `defineAdmin()` in `beforeAll`, NEVER at module scope — the leak guard keeps what a file's module scope registered for every later file, so one module-scope admin closed the permission set for `bun test packages/admin packages/query`.
- **A deliberate query loop declares itself.** `search.ts` runs one indexed lookup per text field on purpose — the query IR is a conjunction, so three small indexed reads beat one unindexed `OR` — and says so through `expectedQueryLoop()` from `@ultimat3/db` — as do `batch.ts` (one row at a time) and `relations.ts` (label reads chunked at 200 ids, never cut). That is the one suppression mechanism: never a comment pragma and never a list of exempt call sites. A new loop here either argues for itself in a `reason` or it is an N+1.
- **The jobs dashboard is every admin's, built from these pieces only** (`jobs/`): four resources — `x_jobs`, `x_job_queues`, `x_job_tasks`, `x_job_workers` — each with a `repo:` over `JobIntrospection` (`job-repo.ts`, `fleet-repo.ts`), scopes, a row scope and `job-actions.ts`'s `AdminAction`s, plus ONE screen (`overview.tsx`, the view `jobs`). `job:read` lists them (the resources' `permission` noun is `job`), `job:manage` runs every action. An actor with an `orgId` sees that org's job rows and none of the fleet. `jobs/boundary.test.ts` refuses a `fetch(`, a socket, an event stream or a hand-written table there; `/_x/jobs` draws `JobsOverview` over the dev queue (`dev/panel-jobs.ts` → `jobs/overview-tab.tsx`, dynamically).
- **A batch is the button's gate once per row** (`batch.ts`): policy, `when`, handler; counts `done`/`refused`/`failed`/`queued`/`remaining`; one audit entry per row. Selection is checked ids or "all matching" — the list URL's own `listWhere`, keyset by id, `MAX_BATCH_ROWS` inline / `MAX_BATCH_QUEUED_ROWS` queued per request. `batch: { threshold }` queues one `admin.batch` job per chunk (`batch-queue.ts`, `batch-job.ts`) under a DERIVED `batchIdOf` (actor, action, rows, input — not the request id), so a retry dedupes; the worker runs it AS the operator. Zero JS: the bar is one form (`batch-bar.tsx`), row checkboxes join it by `form=`; a destructive or input-taking batch is a server round trip. ONE MCP tool per action — a batch action's tool takes `ids`.
- **No test reaches a `.tsx` statically.** `routes.ts` reaches the screens, so a test does `await import('@ultimat3/render/server')` and then `await import('./routes')`: a static import compiles JSX before the loader exists and every later render dies with `React is not defined`.
- **Every admin operation is audited, reads included**, not `/admin`'s counts (a count reads no row). `ListResult` carries its `AuditEntry` on both branches, keyed on the table (`entityId: null`). `AdminSearchResult.audit` carries one entry per resource it decided about — `allowed` per searched resource, a `deniedDraft` per refused one; a resource skipped for no text field, no repo or a repo that THREW (`admin.search.skipped.failed`) is listed in `skipped`, never a 500 for the rest.

## Claimed routes (2026-10-09)

- **Why an app file may serve an admin path again.** 23.0.0 (#49/#50) made the admin serve every
  route itself, through one `hydrate: 'never'` catch-all, to delete the host glue every app wrote
  for GENERATED screens (a repo adapter, a screen module, a `page.tsx` per resource). It also took
  away the one thing a `pages:` entry could not do without a file: carry an island. A 22.x console
  with 40 mounted pages, each in the app's own shell with its own islands, had no upgrade but a
  redesign. Islands are a FILE route's — bundled relative to the file, budgeted, hydrated — so the
  smallest correct seam is to let a file serve the path, not to teach the catch-all islands.
- **The guard stays the admin's.** `claimAdminRoute(admin, path, { load })` returns a config whose
  `policy` and `meta` are the route's and whose `load` answers through the SAME `screenFor` the
  catch-all calls, with `frame: 'none'` (the body without `AdminLayout`): decided, refusal audited,
  403, the author's component never called. The app supplies only its own half of the data
  (`load`, run after the decision) and the route's `hydrate`/`budget`/`navigation`.
- **Who may claim is the mounter's answer, by identity.** Render asks the mount's `claimable(path,
  config)`; the admin answers from a `WeakMap` of configs it issued (`claims.ts`, not exported). A
  hand-written `defineRoute`, or `defineRoute({ ...issued, load })`, is a different object:
  `X_ROUTE_DUPLICATE`, as before. A brand symbol was refused — a spread copies it.
- **Only a `pages:` entry and the dashboard.** A generated screen posts back to its own URL and
  re-renders a refused write from the catch-all, in the admin's layout: one screen in two shells.
- **Moved here:** `dev/panel-db.ts`'s `sanitize` decides "did they type a statement", not "is it
  safe" — never cite it as a security property (the reasoning is under slice 15 above).
