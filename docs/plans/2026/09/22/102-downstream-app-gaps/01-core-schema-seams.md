# 01 — Core and schema seams

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Four leaf pieces that tier-1+ slices import, plus one deletion. No behaviour changes elsewhere
until the consuming slice lands.

## Files to change
- `packages/core/src/set-cookie.ts` (new) + `.test.ts` — `serializeSetCookie(name, value, { maxAgeS, path, sameSite, secure, httpOnly, domain? })`.
  - Defaults: `Path=/; HttpOnly; Secure; SameSite=Lax`, the same attributes `auth/src/session.ts:272` writes by hand.
  - Refuses a name or value holding `;`, `,`, CR/LF or controls.
  - Tier 0, because `http` (slice 05) and `auth` are both tier 2 and may not import each other.
- `packages/auth/src/session.ts:272,277`, `oauth-cookie.ts:191,202` — rewritten over `serializeSetCookie`. Same bytes, pinned by the existing tests.
- `packages/core/src/audit.ts` (new) — move `AuditOutcome`, `AuditFailure`, `AuditRecord`, `AuditSink`, `setAuditSink`/`getAuditSink`/`resetAuditSink` from `packages/action/src/audit.ts:18-107`.
  - Widen `AuditRecord` with `kind: 'action' | 'query'`.
  - Rename `action` to `name`. This is the one breaking rename, so it gets a `BREAKING —` entry for 21.0.0.
  - `@ultimat3/action` re-exports the moved names so `import { setAuditSink } from '@ultimat3/action'` keeps compiling.
- `packages/core/src/aws-sigv4.ts` (new) + `.test.ts` — `signAwsRequest({ method, url, headers, body, region, service, credentials, now })` returns signed `Headers`.
  - Built on `crypto.subtle` HMAC-SHA256. No dependency: Bun has no public SigV4 signer, and `docs/idea/18-build-vs-wrap.md` puts drivers on the seam.
  - Test vectors: the AWS SigV4 test-suite cases (`get-vanilla`, `post-x-www-form-urlencoded`), pasted as fixtures.
  - Consumed by `storage` (slice 03) and `mail` (slice 08).
- `packages/schema/src/t.ts:101-105` area + `provider.ts`, `json-schema.ts` — `t.json()`, a schema accepting any JSON value (`null | boolean | number | string | JsonValue[] | { [k]: JsonValue }`, finite numbers only).
  - Output type `JsonValue`, exported.
  - Projects to JSON Schema `{}` with a `description`.
  - This is the answer to "store the gateway's opaque `data` object verbatim" without a `t.unknown` that disables validation.
- `packages/core/src/config.ts:177-178,213-214,266-267,329-334,413-414` — **delete** `locales` and `defaultLocale` from `AppConfig`/`AppConfigInput`, their defaults, validation and merge.
  - Nothing else reads them (verified: `grep -rn '\.defaultLocale' packages/*/src`). `defineCatalogs({ default, locales })` is the one source the runtime reads (`packages/cli/src/app-load.ts:146`).
  - The same PR edits `packages/cli/src/templates/scaffold-repo.ts:193-194` to stop writing them.
  - `BREAKING —` entry, plus a `wiki/Upgrading.md` 21.0.0 line: "delete `locales`/`defaultLocale` from `app.config.ts`; set `default` in `defineCatalogs`".
- `packages/core/src/index.ts`, `packages/schema/src/index.ts` — named exports.
- `packages/core/README.md`, `packages/schema/README.md` — one section each.

## Steps
1. Move audit types to core. Re-export them from action. `bun run boundaries` must show only the new `action → core` edges, which already exist.
2. Add `serializeSetCookie` and migrate auth's four literals.
3. Add `signAwsRequest` with the test-suite vectors.
4. Add `t.json()`. Make sure `@ultimat3/schema` stays dependency-free (`scripts/lib/tiers.ts` comment at `core -> schema`).
5. Delete the two config keys and update the scaffold template in the same PR. `bun run scripts/config-readers.ts` stays green.

## Tests
- `bun test packages/core/src/set-cookie.test.ts packages/core/src/aws-sigv4.test.ts packages/core/src/audit.test.ts packages/schema/src/t.test.ts`.
- `t.json()` rejects `NaN`, `Infinity`, a `Date` and a function, and accepts nested arrays and objects.
- A SigV4 vector that changes one header byte must produce a different signature.

## Done when
- `bun run typecheck && bun run boundaries` green. `bun run changelog-check` counts the two new `BREAKING —` entries (audit `action` → `name`, config keys).
