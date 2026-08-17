# @ultimat3/admin — boundary

Tier 5. May import tiers 0–4. Exactly one importer: `@ultimat3/cli`, and only of `@ultimat3/admin/dev` — `cli → admin` is a declared sideways edge (`scripts/lib/tiers.ts`) so `x dev` can **mount** `/_x`. The root barrel `@ultimat3/admin` has no importer.

Two products, one package, **two entry points**: `@ultimat3/admin/dev` (`src/dev/index.ts`) = the `/_x` dev dashboard, `@ultimat3/admin` (`src/index.ts`) = the generated app admin (production, authz'd, AI-first). Keep them apart; nothing in `src/dev/` may be imported by an admin view, and the root barrel does not re-export the dev half — a host that mounts `/_x` (the CLI) must not load a Solid component to do it.

## Rules

- **One authz.** `AdminAuthz` (`authz.ts`) is the only decision path. `action-gate.ts`, `crud.ts` and `page-guard.tsx` call `decideAll`; views render what the gate returned. Never add a second check in a view or an MCP handler.
- **A custom page's guard is composed, never written.** `pages.ts` turns a `pages:` entry into an `AdminRoute` carrying `[admin:read, …declared]`; `routes.ts` is the only thing that may hand a page component to a router and it hands the `guardedPage()` wrapper, with `permissions[0]` already in `defineRoute({ policy })`. `AdminPageProps.ctx` is required by the type so the wrapper cannot be bypassed by calling the component directly. An empty permission list is `X_ADMIN_PAGE_UNGUARDED` at `defineAdmin` time — the one place an unauthenticated admin screen could have been born.
- **One bridge per foreign package.** `policy-bridge.ts` is the only file calling `evaluate`/`definePermissions`; `routes.ts` the only one calling `defineRoute`; `mcp.ts` the only one calling `defineAppMcp`; `dev/data.ts` the only one importing introspection (dynamically — `/_x` must stay out of the production graph).
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
- **One read-only SQL guard, and it is `@ultimat3/mcp`'s — the whole verdict, with nothing held back.** `dev/panel-db.ts` calls `assertReadOnlyQuery` (tier 5 → tier 4, already a dependency) rather than keeping a second keyword scan: that guard also refuses a batch, a call into the `pg_read_*`/`pg_advisory_*`/`pg_sleep`/`set_config` families, `FOR UPDATE`, and a delimiter that never closes in all five forms (`'`, `E'`, `"`, `$tag$`, slash-star). A local unterminated-delimiter refusal lived here for one revision and was **deleted**: it tested for a surviving `'`/`"`, so it covered three of the five and called a dollar-quoted body "a quote" — one failure mode, two explanations, and a second detector for a property the guard below already tests. What stays local is the emptiness test and the **way out**: `@ultimat3/mcp` tells its caller to expose an action, which a developer at `/_x` cannot act on. The panel says "Fix the statement, or — if it is meant to write — run it with `x db psql --write`", conditional on purpose: `--write` grants writes, it does not close a delimiter, and it used to be printed as *the* fix for a syntax error.
- **Every admin operation is audited, reads included.** `adminList` was the one call that logged nothing in either direction; `ListResult` now carries its `AuditEntry` on both branches, keyed on the table (`entityId: null`), because the subject of a listing is not a row.
- Money through `assertMoney`, timestamps through `assertZone`, pagination through `pagination.ts`. No `offset`, ever.
- **One cursor codec.** `pagination.ts` is the only file calling core's `encodeCursor`/`decodeCursor`; it wraps them as `encodeAdminCursor`/`decodeAdminCursor`, scoped `admin:<resource>`. An invalid cursor is page one here, not an error page — but the signature is checked first, so a forged one cannot seek.
- Labels are i18n keys derived in `resource.ts` (`admin.<entity>.field.<name>`); only `.tsx` calls `t()`. MCP tool descriptions are literal English (protocol payload, not UI copy).
- Colours only via `ThemeTokenRef` (`--x-*`). Raw hex does not typecheck.
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
