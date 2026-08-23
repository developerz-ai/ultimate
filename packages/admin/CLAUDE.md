# @ultimat3/admin — boundary

Tier 5. May import tiers 0–4. Exactly one importer: `@ultimat3/cli`, and only of `@ultimat3/admin/dev` — `cli → admin` is a declared sideways edge (`scripts/lib/tiers.ts`) so `x dev` can **mount** `/_x`. The root barrel `@ultimat3/admin` has no importer.

Two products, one package, **two entry points**: `@ultimat3/admin/dev` (`src/dev/index.ts`) = the `/_x` dev dashboard, `@ultimat3/admin` (`src/index.ts`) = the generated app admin (production, authz'd, AI-first). Keep them apart; nothing in `src/dev/` may be imported by an admin view, and the root barrel does not re-export the dev half — a host that mounts `/_x` (the CLI) must not load a Solid component to do it.

## Rules

- **One authz.** `AdminAuthz` (`authz.ts`) is the only decision path. `action-gate.ts`, `crud.ts` and `page-guard.tsx` call `decideAll`; views render what the gate returned. Never add a second check in a view or an MCP handler.
- **The subject carries the tenant and the loaded row.** `AdminActor.orgId` reaches `policyActor` and `AdminSubject.row` reaches `evaluate`, so an org-scoped or ownership rule can fire at all. It could not: every admin decision was evaluated with `actor.orgId === undefined` and `row === null`, so a role-only rule allowed and the coarse `admin:read` + `<entity>:read` pair was the only gate on a row — while `adminList`/`adminSearch` add no tenant predicate of their own. `adminDetail`, `adminUpdate` and `adminDestroy` load the row BEFORE the guard, the shape `packages/action/src/invoke.ts` uses; `undefined` means "not loaded" and is left off the subject, `null` means "looked and found none" and fails a row rule closed. Pinned in `policy-subject.test.ts`, which asserts the SUBJECT a policy receives — `staticAuthz` is a grant-list stub and no suite driving it can see any of this.
- **The MCP caller is the ambient actor for the whole call.** `mcp.ts` wraps `callAdminTool` in a child context (or a fresh root one over stdio, where there is no surrounding request), the same rule `@ultimat3/mcp`'s `app-tool.ts` states. `AdminApp.ctx()` builds a plain `CrudCtx` and touches nothing async-local, so everything deriving from `tryUseContext()` — entity's tenant guard, the query cache authority, the jit-preload store — read the TRANSPORT's actor: an agent token authorized as agent X while the repo reads ran as the cookie user's tenant, and over stdio `actorTenant` was `undefined` and `assertRowTenant` a no-op. Pinned in `mcp-context.test.ts`.
- **A custom page's guard is composed, never written.** `pages.ts` turns a `pages:` entry into an `AdminRoute` carrying `[admin:read, …declared]`; `routes.ts` is the only thing that may hand a page component to a router and it hands the `guardedPage()` wrapper, with `permissions[0]` already in `defineRoute({ policy })`. `AdminPageProps.ctx` is required by the type so the wrapper cannot be bypassed by calling the component directly. An empty permission list is `X_ADMIN_PAGE_UNGUARDED` at `defineAdmin` time — the one place an unauthenticated admin screen could have been born.
- **One `AdminAction.name`, one handler.** The name is the MCP tool name (`admin.action.<name>`), the default label key, AND the key `callAdminTool` resolves a handler by — three addresses, one string. Two actions sharing it is `X_ADMIN_ACTION_DUPLICATE` at `defineAdmin` time (`admin.ts`, `mcp.test.ts`), not at the first agent call: `.find()` on a name dispatches to whichever resource came first, which is a call that SUCCEEDS against the wrong action and reports nothing. Refused at declaration rather than in `adminMcp()` because an app that renders the dashboard and never wires MCP has the same two broken label keys and the same ambiguous dispatch. The framework's own examples already qualify the name with the entity (`post.publish`) — the `fix:` line is that convention, made into the instruction. The same object attached through both `actions:` and `resources[e].actions` is one action, not two: identity, not name, is what "already seen" means.
- **A host that serves an admin URL itself reads its gate, never restates it.** `adminRouteFor(app, path)` (`routes.ts`) is that read, and `AdminRouteConfig.policy` is what it hands over — the same object `config.policy` carries, non-optional so a caller need not prove it exists. Typing `policy: { permission: 'admin:read' }` into a page file beside a route table that already declares one for that URL is two declarations of one URL's authz; they agree until somebody edits one. The deployed demo shipped exactly that on five pages until 1.2.0, and its `apps/admin/app/admin/route-policy.test.ts` is the rule made executable: a quoted permission anywhere under `app/admin/**/page.tsx` fails the suite. An undeclared path is `X_ADMIN_PAGE_PATH_INVALID`, listing the paths that would have worked.
- **A `/_x` source reads a registry through its DESCRIPTOR TYPE, never as an untyped bag.** `import type { RouteDescriptor }` beside the dynamic `import()` — the type is erased, so /_x still costs the production graph nothing, and a renamed descriptor field becomes a typecheck failure in `dev/data.ts` naming the field. The bag was defended here as tolerance and bought three panels that were wrong for every row and could not go red: `route['render']`, `route['budget']`, `route['revalidate']`, `job['idempotencyKey']` and `entity['drift']` are names no descriptor has ever published, so a read answered `undefined`, took the fallback, and shipped the fallback as a fact — every route `stream` with no budget and no tag, every job non-idempotent, every schema drift-free. `dev/published-keys.test.ts` is the runtime half a type cannot answer: it walks what the real registries EMIT, so a field the type declares and the projection never writes is a red test.
- **A fact `/_x` cannot know is absent or `null` — never a value that happens to be constant.** `hasMeta` was dropped because `defineRoute()` refuses a route with no `meta`, so `missingMeta` was a defect list with no member it could hold; `JobDescriptor.idempotent` is published *because* `job()` refuses a definition without a key — a guarantee shown where the question is asked. `DbPanelData.drift` is `null` when nothing wired the check, because drift is the entities against the DATABASE and `[]` claims a match nobody verified.
- **One bridge per foreign package.** `policy-bridge.ts` is the only file calling `evaluate`/`definePermissions`; `routes.ts` the only one calling `defineRoute`; `mcp.ts` the only one calling `defineAppMcp`; `dev/data.ts` the only one importing introspection (dynamically — `/_x` must stay out of the production graph). Source only: a **test** declares the permissions its own `can()` fixtures use, because `definePermissions` writes a process-global registry and `bun test` seats several files in one process — `dev/data.test.ts` relied on the empty-registry-means-permissive fallback and went red the first time it shared a process with anything that imports this package.
- **One entity surface** (`registry.ts`) — the admin reads what `entity()` actually exposes: `$name`, `$primaryKey`, `$columns[c].$meta`, `$schema`, `$describe()`. It is a structural subset so a new column kind still derives, and `RegisteredEntity` is the `tsc`-checked proof that a real `entity()` result satisfies it — never a comment claiming it does.
- **One flattener.** `entity-columns.ts` is the only file that reads `$meta` or calls `$describe()`; everything downstream takes `AdminColumnFacts`. Money stays one property (the admin renders rows, not tables), a FK target comes back resolved from `$describe()`, and only a **generated** default (`uuid`, `now`) is read-only — `.default('free')` is a starting value.
- **A deliberate query loop declares itself.** `search.ts` runs one indexed lookup per text field on purpose — the query IR is a conjunction, so three small indexed reads beat one unindexed `OR` — and says so through `expectedQueryLoop()` from `@ultimat3/db` (tier 1, downward, and the only thing this package imports from it). That is the one suppression mechanism: never a comment pragma and never a list of exempt call sites. A new loop here either argues for itself in a `reason` or it is an N+1.
- **The timeline panel renders the detector's verdicts, it does not re-derive them.** `repeatedSql` (`dev/panel-timeline.ts`) is a measurement over the trace this panel recorded — every SQL text seen twice. `nPlusOne` is the verdict: `x dev`'s statement ledger, read through `DevSources.statementLoops()` and scoped to the selected request, in the ledger's own order. A second count here would be blind to the `expectedQueryLoop` above and to statement attribution (`members.findById`, not raw SQL text), and would disagree with the `fix:` an author actually pastes. No detector wired → `null`, never `[]`: "nobody counted" is not "this request was clean".
- **This catalog is the framework's one opt-OUT MCP surface, and that is deliberate.**
  `mcp-tools.ts` is the only file that does not call `isMcpExposed` from `@ultimat3/core`: every
  tool here is already gated on an admin permission, and the CRUD tools carry no `mcp` block at
  all, so opting in would list `admin.posts.delete` while hiding the action button beside it.
  `mcp: { expose: false }` withdraws one. Stated there, in core's `mcp-exposure.ts`, and in
  `wiki/Admin-Dashboard.md` — a *second* exception anywhere is the bug.
- **`dev/panel-db.ts`'s `sanitize` decides "did they type a statement", not "is it safe".** It blanks every opaque span in ONE left-to-right pass — `'…'`, `"…"`, `$tag$…$tag$` and both comment forms in a single alternation, because each form can contain another's opener — so `-- still typing` reads as an empty box. It used to feed a write-keyword scan in this file and that scan is gone; **do not cite it as a security property**. It once said an unterminated quote "leaves the rest visible — the guard fails closed": true of the scan it fed, meaningless now, and it never covered `$tag$` or slash-star, whose surviving character is `$` or `/`.
- **A dev panel catches only the error that means "not wired".** `DevSourceUnavailableError` and nothing wider: a bare `catch` in `dev/panel-live.ts` reported an authz refusal and a dropped NATS connection from a *running* sync node as `dev.live.no-sync-node`, telling the reader to install a tier they already had. Everything else reaches `panelPayload`, which renders its code and its fix.
- **What an entity does not declare, the admin does not invent.** `sensitive`, a fixed `currency` and `labelField` come from `AdminResourceOptions` or they are absent. Same rule for a URL: the reference widget links through `WidgetContext.hrefFor` or renders plain text — it used to build `/${entity}s/${id}`, which is English pluralisation by concatenation and drops `basePath`. The route table is `AdminApp`'s; a widget three layers down does not get to guess it.
- **`assertReadOnly` answers a VERDICT carrying the runnable string, and the panel executes THAT.**
  `assertReadOnlyQuery` documents that what it returns is what the caller must execute — every
  check ran on a stripped form and the return is the reconciled one — and `panel-db.ts` discarded
  it and ran the textarea's bytes. Benign only for as long as `verbatim()` normalises nothing more
  than a trailing `;`, which is a promise no other file is keeping; `@ultimat3/mcp`'s own
  `dev-server.ts` honours the contract, and a `string | null` return here made it impossible to.
  `ReadOnlyVerdict` is exported from `@ultimat3/admin/dev` beside it.
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
- **The locale picker reads `registeredLocales()`, not a bundled list.** It was
  `['en','es','de','fr','pt','ja']`, one line under a comment forbidding exactly that for IANA
  zones: an app registering `it` could not pick it, and an app with only `en` was offered five
  locales it renders `⟦key⟧` for. No fallback — an app with no catalog has no locale to offer, and
  inventing one is the admin declaring what the app did not.
- **One read-only SQL guard, and it is `@ultimat3/mcp`'s — the whole verdict, with nothing held back.** `dev/panel-db.ts` calls `assertReadOnlyQuery` (tier 5 → tier 4, already a dependency) rather than keeping a second keyword scan: that guard also refuses a batch, a call into the `pg_read_*`/`pg_advisory_*`/`pg_sleep`/`set_config` families, `FOR UPDATE`, and a delimiter that never closes in all five forms (`'`, `E'`, `"`, `$tag$`, slash-star). A local unterminated-delimiter refusal lived here for one revision and was **deleted**: it tested for a surviving `'`/`"`, so it covered three of the five and called a dollar-quoted body "a quote" — one failure mode, two explanations, and a second detector for a property the guard below already tests. What stays local is the emptiness test and the **way out**: `@ultimat3/mcp` tells its caller to expose an action, which a developer at `/_x` cannot act on. The panel says "Fix the statement, or — if it is meant to write — run it with `x db psql --write`", conditional on purpose: `--write` grants writes, it does not close a delimiter, and it used to be printed as *the* fix for a syntax error.
- **Every admin operation is audited, reads included.** `adminList` was the one call that logged nothing in either direction; `ListResult` now carries its `AuditEntry` on both branches, keyed on the table (`entityId: null`), because the subject of a listing is not a row. `adminSearch` was the second, and it read rows out of EVERY readable entity: `AdminSearchResult.audit` now carries one entry per resource it decided about — `allowed` per searched resource, a `deniedDraft` per refused one. A resource skipped for having no text field or no repo is not an authz event and writes none.
- Money through `assertMoney`, timestamps through `assertZone`, pagination through `pagination.ts`. No `offset`, ever.
- **One cursor codec.** `pagination.ts` is the only file calling core's `encodeCursor`/`decodeCursor`; it wraps them as `encodeAdminCursor`/`decodeAdminCursor`, scoped `admin:<resource>`. An invalid cursor is page one here, not an error page — but the signature is checked first, so a forged one cannot seek.
- Labels are i18n keys derived in `resource.ts` (`admin.<entity>.field.<name>`); only `.tsx` calls `t()`. MCP tool descriptions are literal English (protocol payload, not UI copy).
- Colours only via `ThemeTokenRef` (`--x-*`). Raw hex does not typecheck.
- **One owner of `globalThis.React`, and it is `@ultimat3/ui`'s.** `inert-jsx.ts` keeps the walkers (`nodesOf`, `shallowNodesOf`, `renderNodes`, `renderHtml`) and delegates install/restore to `probe`/`unprobe` from `@ultimat3/ui/jsx-probe` — tier 5 → tier 4, downward, no declared edge needed. It kept its own `depth`/`saved` pair until 2026-08-22 and two counters over one property restore in the wrong order: admin installs (saving the real binding), ui installs (saving ADMIN's factory), admin restores, ui restores admin's factory back over the top. `bun test` seats both packages in one process, so the interleave is reachable; `inert-jsx.test.ts` drives it in both orders.
- Views are pure functions of props — no `createSignal`, no local state; the route owns it.

## Layout

| File | Owns |
|---|---|
| `admin.ts` | `defineAdmin` → resources, nav, route table, audit, authz |
| `pages.ts` / `page-guard.tsx` | a `pages:` entry → route + nav item (pure) / the wrapper that decides before it renders |
| `routes.ts` | the only `defineRoute` caller: mode per view, `policy` composed from the route's permissions |
| `registry.ts` / `entity-columns.ts` | the entity surface the admin reads / one entity → column facts |
| `resource.ts` / `fields.ts` / `widget-value.ts` | derivation, widget table, value guards |
| `crud.ts` / `action-gate.ts` | policy → confirmation → validation → repo → audit |
| `mcp-tools.ts` / `mcp.ts` | tool derivation (pure) / transport wiring |
| `dev/server.ts` + `dev/panel-*.ts` | `/_x` mount guard and one panel per file |

## Commands

```bash
bun test --filter @ultimat3/admin
bun run --filter @ultimat3/admin typecheck
```
