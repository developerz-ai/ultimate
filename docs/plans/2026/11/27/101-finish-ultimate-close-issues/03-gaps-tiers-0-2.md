# 03 — Framework gaps, tiers 0–2: egress proxy, unknown-key walker, mail recipient, batched policy

> Part of [`overview.md`](overview.md). Depends on: 02. Tiers: 0 (`core`, `schema`), 2 (`auth`, `policy`). Downstream asks + #1281 (schema half). All additive: nothing on `main` gets stricter.

## Files to change

| Item | Files | Change |
|---|---|---|
| App-wide egress proxy | `packages/core/src/config.ts` (layered like `notify`) | `outbound: { proxy?: string; direct?: readonly string[] }` in `app.config.ts` |
| | `packages/core/src/outbound-default-proxy.ts` (new) | `configureOutboundProxy()` set once at boot — the `configureCursorSigning` pattern; apps never call it |
| | `packages/core/src/outbound.ts:90` (`prepare()`) | `request.proxy === undefined ? ambient : request.proxy`; per-call URL/resolver still wins; `proxy: null` = direct (widens `OutboundProxy` additively); loopback + `direct` hosts always direct (in-cluster OTLP via `otlp-post.ts`) |
| | one cli boot file (`packages/cli/src/serve-boot.ts`) | call `configureOutboundProxy` from config |
| | call sites: none | `notify/src/apns.ts:119`, `fcm.ts`, `pwa/src/push-send.ts`, `mcp/src/remote-client.ts`, auth OAuth discovery already go through `outbound()` — that is the one way. Grep for a raw transport bypassing it before closing. |
| Unknown input keys (schema half, #1281) | `packages/schema/src/unknown-keys.ts` (new), `index.ts` | pure walker `unknownKeys(schema, value) → { path, key, declared }[]` over the `SchemaNode` IR: object properties, array items; a **discriminated** union walks only the arm its discriminant selects (a key borrowed from a sibling arm is unknown); a plain union reports a key only when no arm declares it; records/JSON skipped. `validators.ts:229`, `json-schema.ts:319` unchanged. |
| Mail recipient ≠ store key | `packages/auth/src/verify.ts:58-68,111` | `IssueVerificationInput.to?: string`; send to `input.to ?? identifier`; blank `to` refused before `putVerification` with the package's existing input error; `to` is not normalised by `purpose.identifier` (caller's job) |
| | `packages/auth/src/member-invite.ts:107-111` | drop the internal `addressed` wrapper; pass `to` |
| Batched policy (mechanism half) | `packages/policy/src/evaluate.ts`, `index.ts` | `evaluateEach(policy, { input, actor, ctx, rows }, options)` → one `PolicyEvaluation` per row by calling `evaluate()`; one decision event per row (audit unchanged). No second authz path. |

Not shipped (axiom 8): a bulk-action factory (skip-denied vs abort-all is business convention); vendor
bounce normalisers beyond SES; usage history.

## Steps

1. Workers (exclusive paths): A1 `packages/core/src/outbound*.ts`, `config*.ts`, the boot wiring line; A2 `packages/schema/src/unknown-keys*.ts`, `schema/src/index.ts`; A3 `packages/auth/src/verify*.ts`, `member-invite*.ts`; A4 `packages/policy/src/evaluate*.ts`, `policy/src/index.ts`.
2. Coordinator: `bun run manifest`, `CHANGELOG.md` + `wiki/Upgrading.md` (`bun run changelog-check`), wiki pages (`wiki/Outbound-HTTP.md`, `wiki/Auth.md`, `wiki/Policies.md`).

## Tests

- `packages/core/src/outbound-default-proxy.test.ts` — ambient applies; per-call wins; `null` direct; loopback/`direct` hosts direct; credentials redacted in `x doctor`/logs; `socks5:` still refused by `proxyFor` (`X_OUTBOUND_PROXY_INVALID`).
- `packages/schema/src/unknown-keys.test.ts` — nested, arrays, unions, records skipped; a field borrowed from a sibling discriminated arm is reported.
- `packages/auth/src/verify.test.ts` — key ≠ recipient; blank `to` writes no row; `member-invite.test.ts` unchanged and green.
- `packages/policy/src/evaluate-each.test.ts` — N rows ⇒ N decisions, N events; mixed allow/deny.
- `bun test ./packages/core/src/outbound-default-proxy.test.ts` etc.

## Done when

- A framework sender (APNs) honours `outbound.proxy` with no call-site change.
- `unknownKeys` is exported and pure; `evaluateEach` exported.
- `contract-diff` additive only; `bun run verify` green.
