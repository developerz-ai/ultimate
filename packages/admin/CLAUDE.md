# @ultimat3/admin — boundary

Tier 5. May import tiers 0–4. Nothing imports this.

Two products, one package: `src/dev/*` = the `/_x` dev dashboard (dev only), `src/*` = the generated app admin (production, authz'd, AI-first). Keep them apart; nothing in `src/dev/` may be imported by an admin view.

## Rules

- **One authz.** `AdminAuthz` (`authz.ts`) is the only decision path. `action-gate.ts` and `crud.ts` call `decideAll`; views render what the gate returned. Never add a second check in a view or an MCP handler.
- **One bridge per foreign package.** `policy-bridge.ts` is the only file calling `evaluate`/`definePermissions`; `routes.ts` the only one calling `defineRoute`; `mcp.ts` the only one calling `defineAppMcp`; `dev/data.ts` the only one importing introspection (dynamically — `/_x` must stay out of the production graph).
- **Structural registry types** (`registry.ts`) — the admin reads `name`/`columns`/repo methods, so a registry that grows a field changes one file.
- Money through `assertMoney`, timestamps through `assertZone`, pagination through `pagination.ts`. No `offset`, ever.
- **One cursor codec.** `pagination.ts` is the only file calling core's `encodeCursor`/`decodeCursor`; it wraps them as `encodeAdminCursor`/`decodeAdminCursor`, scoped `admin:<resource>`. An invalid cursor is page one here, not an error page — but the signature is checked first, so a forged one cannot seek.
- Labels are i18n keys derived in `resource.ts` (`admin.<entity>.field.<name>`); only `.tsx` calls `t()`. MCP tool descriptions are literal English (protocol payload, not UI copy).
- Colours only via `ThemeTokenRef` (`--x-*`). Raw hex does not typecheck.
- Views are pure functions of props — no `createSignal`, no local state; the route owns it.

## Layout

| File | Owns |
|---|---|
| `admin.ts` | `defineAdmin` → resources, nav, route table, audit, authz |
| `resource.ts` / `fields.ts` / `widget-value.ts` | derivation, widget table, value guards |
| `crud.ts` / `action-gate.ts` | policy → confirmation → validation → repo → audit |
| `mcp-tools.ts` / `mcp.ts` | tool derivation (pure) / transport wiring |
| `dev/server.ts` + `dev/panel-*.ts` | `/_x` mount guard and one panel per file |

## Commands

```bash
bun test --filter @ultimat3/admin
bun run --filter @ultimat3/admin typecheck
```
