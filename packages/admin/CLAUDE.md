# @ultimat3/admin — boundary

Tier 5. May import tiers 0–4. Exactly one importer: `@ultimat3/cli`, and only of `@ultimat3/admin/dev` — `cli → admin` is a declared sideways edge (`scripts/lib/tiers.ts`) so `x dev` can **mount** `/_x`. The root barrel `@ultimat3/admin` has no importer.

Two products, one package, **two entry points**: `@ultimat3/admin/dev` (`src/dev/index.ts`) = the `/_x` dev dashboard, `@ultimat3/admin` (`src/index.ts`) = the generated app admin (production, authz'd, AI-first). Keep them apart; nothing in `src/dev/` may be imported by an admin view, and the root barrel does not re-export the dev half — a host that mounts `/_x` (the CLI) must not load a Solid component to do it.

## Rules

- **One authz.** `AdminAuthz` (`authz.ts`) is the only decision path. `action-gate.ts` and `crud.ts` call `decideAll`; views render what the gate returned. Never add a second check in a view or an MCP handler.
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
- **What an entity does not declare, the admin does not invent.** `sensitive`, a fixed `currency` and `labelField` come from `AdminResourceOptions` or they are absent.
- Money through `assertMoney`, timestamps through `assertZone`, pagination through `pagination.ts`. No `offset`, ever.
- **One cursor codec.** `pagination.ts` is the only file calling core's `encodeCursor`/`decodeCursor`; it wraps them as `encodeAdminCursor`/`decodeAdminCursor`, scoped `admin:<resource>`. An invalid cursor is page one here, not an error page — but the signature is checked first, so a forged one cannot seek.
- Labels are i18n keys derived in `resource.ts` (`admin.<entity>.field.<name>`); only `.tsx` calls `t()`. MCP tool descriptions are literal English (protocol payload, not UI copy).
- Colours only via `ThemeTokenRef` (`--x-*`). Raw hex does not typecheck.
- Views are pure functions of props — no `createSignal`, no local state; the route owns it.

## Layout

| File | Owns |
|---|---|
| `admin.ts` | `defineAdmin` → resources, nav, route table, audit, authz |
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
