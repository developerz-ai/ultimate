# 26-api-read-contract — A read's rows and a mount's cut are published contract

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`query`), 4 (`manifest`), 5 (`cli`).

## Why
Every read publishes an untyped answer while its row schema sits on the declaration. Probe: a query with `rows: t.object({ id, title })` through `toQueryOpenApiOperation` printed `"rows":{"type":"array","items":{}}`. The MCP tool of the same read already publishes that row (`packages/mcp/src/projectable.ts:90`), so the two surfaces disagree.
Measured in committed mount documents: untyped `200` on 5 of 10, 14 of 14 and 44 of 44 `GET`s in three adopters, who declare `rows:` in 10, 39 and 87 files. One of them keeps 498 LOC of golden tests plus a hand-written 331-LOC model file in its client to pin what the document will not say.
The cut is unguarded too: `packages/manifest/src/schema.ts` holds no mount fact. Dropping a name from a mount's `scopes`, or changing its `prefix`, turns a customer's call into a 404. `x manifest` regenerates the mount's document and `contract-diff` stays green (`packages/manifest/src/diff-operations.ts:112` only sees the primitive, still registered).

## Files to change
- `packages/query/src/openapi.ts:52-73` — `ANSWERS` becomes a function of the row schema; no `rows:`, or one that cannot be introspected, stays today's bytes.
- `packages/query/src/openapi.ts:112-114`, `:154`, `:236` — list and single answers use it.
- `packages/manifest/src/schema.ts:191` — `QueryFact.rows?`; new `MountFact`, `Manifest.mounts?`.
- `packages/manifest/src/sources.ts:128` — `rows` from `getQuery(name)`; `mounts` from `apiDeclaration()` (`packages/action/src/index.ts:51`), prefix and scopes only, never `resolveToken`.
- `packages/manifest/src/diff-operations.ts:112` — diff `rows`.
- `packages/manifest/src/diff-mounts.ts` (new), `packages/manifest/src/diff.ts:35` — wired into `diffManifest`.
- `wiki/Queries-And-Live-Queries.md:23-31`, `:106` — a `rows` field row (absent from the table today), and the OpenAPI row. `packages/query/README.md`, `packages/query/CLAUDE.md`, `packages/manifest/README.md`, `packages/manifest/CLAUDE.md`.
- `examples/dummy/`, `dummy/social-media-clone/` — regenerated `openapi.json`, `x.manifest.json`. `liveRunEvents` in `examples/dummy/apps/web/app/runs/keys.ts:22` shows it through `/v1` if it declares `rows:`; declare it if not.

## Steps
1. Row schema: `toWireOutputSchema(target.rows)` from `@ultimat3/schema`, the call `packages/mcp/src/projectable.ts:124` makes. Inline in the operation, never a component: `packages/cli/src/app-openapi.ts:34-38` merges only `paths` from this package.
2. List: `{ oneOf: [array of row, page envelope with rows of row] }`. Single: the row. `recordEnvelopeSchema` wraps either, as today.
3. `QueryFact.rows`: the same wire schema, written only when declared, like `subscribes`.
4. Diff rows: member added, additive; member removed, type changed, or required became optional, `breaking`. An absent side is no evidence, the rule `QueryFact.input` documents at `packages/manifest/src/schema.ts:193-197`. Not `canonicalJson` inequality as for an action's output (`diff-operations.ts:33`): an entity gaining a column would flip every `rows: X.$schema` read to breaking.
5. `MountFact`: `{ prefix, scopes: Record<scope, sorted names> }`, sorted by prefix.
6. Diff mounts: prefix removed, a name leaving the cut, or a name moving scope, `breaking`, because a held token stops reaching it. A mount, name or scope added, additive.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MANIFEST_BREAKING` (existing) | a row member removed or retyped; a name or prefix gone from a mount | the code's existing fix. No new code, no `bun run new-error-code` |

## Tests
- `packages/query/src/openapi.test.ts` — `rows:` publishes members in list, page envelope and single; no `rows:` is byte-identical to today. A `.sealed()` column is absent (`packages/entity/src/entity.ts:150`): extends the `sealed-egress.test.ts` matrix. Must fail before the change.
- `packages/manifest/src/diff-mounts.test.ts` — each row of step 6, both directions.
- `packages/manifest/src/diff.test.ts` or sibling — row added additive, removed breaking.
- `bun test packages/query/src/openapi.test.ts packages/manifest`.

## Semver
Breaking, one row: an app declaring `rows:` or a mount finds its committed `openapi*.json` and `x.manifest.json` stale after upgrade (`X_MANIFEST_STALE`). Upgrading: run `x manifest`, commit. Slice [`10-schema-sensitive-and-rules.md`](10-schema-sensitive-and-rules.md): a `.sensitive()` member's schema is published like any other; the wire schema decides.

## Done when
- A mounted read with `rows:` publishes its members; a typed client generated from that document has no `unknown` row.
- A scope-map edit removing a name fails `bun run x -- verify --only contract-diff` on `examples/dummy`.
- Both tracked apps regenerated; `bun run scripts/reference-app-gate.ts` green.
