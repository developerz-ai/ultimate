# 05 — render, mcp, mail, admin

> Part of [`overview.md`](overview.md). Depends on: 03 (render guard mirrors http). Tier: 4–5.

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `packages/admin/src/crud.ts:282` (update), `:245` (create) | policy checked against `before` only (update) / no row and no input (create); `AdminSubject.input` declared, never filled → tenant rule `row.orgId === actor.orgId` lets `acme` actor move a row to `orgId: 'victim'` or create in it. MCP `update`/`create` tools expose `orgId` | CONFIRMED, high (security) |
| `packages/mcp/src/validate-args.ts:190` | compiles `pattern` without flags (`@ultimat3/schema` publishes `regex.source` only) → `/^[a-z]+$/i` rejects `'ABC'`, `/^\p{L}+$/u` rejects `'é'`; action accepts both | CONFIRMED, high |
| `packages/render/src/navigation-rules.ts:249-250`, `packages/render/src/navigation.ts:260` | `responseVerdict` returns `load` for any cross-origin URL incl. `javascript:` → `win.location.assign` | CONFIRMED, med (security) — client half of 03 step 2 |
| `packages/mail/src/mime.ts:84` | `Reply-To` emitted `verbatim`, not `address` → raw 8-bit bytes, non-ASCII mailbox not refused (SMTP driver only) | CONFIRMED, med |

## Steps
1. `crud.ts`: create → `subject.input` = validated value; update → decide again on the validated merged row (or `subject.input = validatedPatch`). Load-then-decide, as `crud.ts` header already describes after `invoke.ts`.
2. `validate-args.ts`: carry flags in the wire schema (e.g. `x-flags` alongside `pattern`) and compile with them; or, if the wire can't carry them, drop `pattern` from `narrow()` when flags are non-empty (same keep-only-what-we-enforce rule as `format`). Pick one — one path.
3. `navigation-rules.ts`: before `load`/`follow`, refuse non-`http:`/`https:` → treat as document load of the requested URL.
4. `mime.ts`: `header('Reply-To', …, 'address')`; audit the rest of `messageHeaders` that go out verbatim.

## Tests
- `packages/admin/src/crud.test.ts` or `mcp-tenant.test.ts` — cross-org create and update refused.
- `packages/mcp/src/cross-surface.test.ts` — `i` and `u` flag cases agree with schema parse.
- `packages/render/src/navigation-rules.test.ts` — `javascript:` / `data:` never yields `load`.
- `packages/mail/src/mime.test.ts` — non-ASCII Reply-To → encoded word; non-ASCII mailbox refused.
- `bun test packages/admin packages/mcp packages/render packages/mail`

## Not a bug (don't reopen)
- MCP exposure requires literal `expose: true`; admin MCP catalog + per-call decision; `rpc()` ignoring `http.path` pins (documented); idempotency `release()`; notify digest ledger key; scraping redirect/cookie/robots; ai budget + SSE; mail QP + dot-stuffing.

## Done when
- Tests fail on `fcfe31dc`, pass after; `bun run verify` `unit` + `contract` green.
