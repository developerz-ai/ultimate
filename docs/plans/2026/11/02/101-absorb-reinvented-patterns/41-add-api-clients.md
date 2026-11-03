# 41 — One OpenAPI compiler: a client for your customers, a client for your vendors

> Part of [`overview.md`](overview.md). Depends on: [`11-core-outbound.md`](11-core-outbound.md), [`26-api-read-contract.md`](26-api-read-contract.md), [`39-api-mount-paths.md`](39-api-mount-paths.md) (`in: path`, non-POST operations), [`39-action-declared-errors.md`](39-action-declared-errors.md) (per-operation refusals). Tier: 5 (`cli`), output imports 0.

## Why
**Out.** An app publishes `openapi.json` (`cli/src/app-openapi.ts:46`). `rpc<TActions>` types only reach code that can import the app's action types (`action/src/client.ts:103`). A customer's TypeScript gets nothing, so a team with a public API hand-writes an SDK or buys one, and it drifts from the contract `contract-diff` already protects.

**In.** Calling a vendor means hand-typing its shapes. One adopter's generator was measured small, and that signal once killed this. The bar is now whether a serious team needs it: every team integrating a documented API does. Vendor shapes hand-typed around `outbound()` lose response checks, so a renamed field surfaces as `undefined` in a job at 3 a.m.

One compiler, two emitters, so neither is a second way. `rpc` stays the only client inside the app's own repo: the generated client is for code that cannot import it. This also answers mounts: a third party targets a mount's document (`mountOpenApi`, `action/src/index.ts:193`), so `rpc` needs no route to one.

## Decisions
| Question | Answer |
|---|---|
| Dependency | none. No generator package. The compiler is ours and small: `$ref`, objects, arrays, enums, `oneOf`, `allOf`, nullable |
| Vendor output | `t` schemas plus `outbound()`, deadline and `dial` from the caller's wrapper |
| Customer output | no `@ultimat3/*` import: plain `fetch`, types, and a hand-typed-free `problem` error. Publishable as is |
| Publishing | never ours. `--out` writes a directory; the team's package and registry are its own (axiom 7's spirit) |
| Unsupported construct | refused with the JSON pointer. Never `unknown` silently |
| Auth | a `headers()` callback in both. Token storage is the app's (`11`'s decision) |
| Pagination, retries | customer client: `Retry-After` honoured, once. Pagination: the cursor fields as the contract states them, no iterator guess |

## Files to change
- `packages/cli/src/openapi-compile.ts` (new) — document to a neutral operation list, the only reader.
- `packages/cli/src/openapi-refuse.ts` (new) — the refusals, with pointers.
- `packages/cli/src/client-emit-vendor.ts`, `client-emit-customer.ts` (new) — the two emitters.
- `packages/cli/src/cmd-client.ts`, `cmd-client-spec.ts` (new); `packages/cli/src/registry.ts` — `x client`.
- `packages/cli/src/generate-kinds.ts` — nothing: `x g` scaffolds primitives; a generated client is an artifact, not a primitive.
- `packages/cli/src/verify-checks.ts` — `drift` step: a checked-in client whose source document changed, or whose bytes differ from the header's hash. No shipped guard: `drift` does this job.
- `examples/dummy/` — `x client vendor` over a small fixture `openapi.json`, called from one job; `x client customer` output used by one contract test.
- `wiki/CLI-Reference.md`, `wiki/Actions.md`, `packages/cli/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`.
- `wiki/Actions.md` also gets the bulk row: a bulk endpoint is `hive({ member, split, onMemberError })`, `ai/src/hive.ts:65`, an action with per-item outcomes, in the OpenAPI and client by construction.

## Steps
1. `x client vendor <name> --from <file|url> [--only <tag,…>] [--json]`. Writes `packages/clients/<name>/{client.ts,schemas.ts,source.json}`. `source.json` is the input, committed, so regeneration is reproducible and offline. A `url` is read through `outbound({ dial: 'public' })`.
2. Each operation: `async getInvoice(input, { signal }): Promise<Invoice>`, path parameters filled from `input`, method as the document states. A declared refusal is a typed error on the customer client, read from the narrowed `Problem`. Input and response parsed with `t`. Bad response: `X_CLIENT_RESPONSE_INVALID` with the pointer and field. A documented non-2xx becomes `X_OUTBOUND_REFUSED` with `meta.status` (`11`).
3. `x client customer [--mount <prefix>] --out <dir> [--json]`. From the app's own document via `openApiJson` (`app-openapi.ts:46`), or a mount's. Output: `index.ts`, `types.ts`, and `package.json` only with `--package <name>`. Zero imports beyond the platform. Tested by compiling under `strict` with no `@ultimat3/*` on the path.
4. Names from `operationId` (`action/src/naming.ts`), stable. So `contract-diff` red means a customer's client breaks, the same fact in one place.
5. Generated files carry a header with the source hash. `drift` raises `X_CLIENT_STALE` on mismatch, `X_CLIENT_EDITED` on a hand edit. The header check is the convention's build error.
6. Regenerate with no flags reads `source.json`: `x client vendor <name>`.
7. Requires 26: without `rows:` in OpenAPI, reads would generate as untyped.

## Error codes
`bun run new-error-code` for each row, off-socket unless noted.

| Code | When | Fix |
|---|---|---|
| `X_CLIENT_SPEC_UNSUPPORTED` | a construct the compiler refuses | names the pointer; `--only` around it, or pin a corrected `source.json` |
| `X_CLIENT_SPEC_INVALID` | not an OpenAPI 3.0 or 3.1 document | point `--from` at the document |
| `X_CLIENT_STALE` | `source.json` changed, output did not | `x client vendor <name>` |
| `X_CLIENT_EDITED` | a generated file changed by hand | regenerate; wrap it in your own file |
| `X_CLIENT_RESPONSE_INVALID` (`--status 502`) | a vendor's answer fails its declared shape | regenerate from the vendor's current document |

## Tests
- `packages/cli/src/openapi-compile.test.ts`: fixtures for each construct; a refused one names its pointer; recursive `$ref` survives.
- `packages/cli/src/client-emit-customer.contract.test.ts`: generate from `examples/dummy`'s document, compile, call a running contract app, get typed rows. Fails if an operation is missing.
- `packages/cli/src/client-emit-vendor.test.ts` under `mockFetch` (08): a renamed field gives `X_CLIENT_RESPONSE_INVALID`.
- `packages/cli/src/cmd-client.test.ts`: `--json` on success and each refusal; a hand edit red.
- `bun test packages/cli/src/openapi-compile.test.ts`

## Semver
minor. A new command and new codes. The eight primitive shapes are untouched.

## Done when
- A customer client generated from `examples/dummy` compiles with no framework import and passes against the app.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
