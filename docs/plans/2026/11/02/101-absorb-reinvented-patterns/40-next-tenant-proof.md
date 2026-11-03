# 40-next-tenant-proof — The gate attacks every action, query and job from another tenant

> Part of [`overview.md`](overview.md). Depends on: [`40-next-exercise-pass.md`](40-next-exercise-pass.md), [`05-entity-tenant-and-locks.md`](05-entity-tenant-and-locks.md). Tier: 2 (`entity`), 5 (`testing`, `cli`).

## Why
Broken object-level authorization is the top API flaw across the industry, and the one an agent writes without noticing. The repository guard is strong, but it covers scoped rows only. Reproduced 2026-11-02, actor in org B, row in org A, memory repository:

| Read | Printed |
|---|---|
| tenant-columned parent, by id | `null` |
| child with a foreign key to it and no tenant column, by id | `{"url":"s3://A-secret",…}` |

No code refuses that declaration; slice 05 binds only keys where both ends are scoped. Other paths past the guard: `crossTenant()`, raw SQL, a service actor inside a handler, a hand-built cache key. `examples/dummy` has 21 of 32 actions taking `orgId`, 25 of 32 actions and 9 of 12 queries taking a uuid: each is an id an attacker can choose. Today's generated test asks only whether an anonymous caller is denied (`action/src/contract-test.ts:68`).
Hard to match: the oracle needs tenancy, roles, input schema, every surface and a seed the framework itself generated. Elsewhere this is a paid pentest, once a year.

## Decisions
| Question | Answer |
|---|---|
| Oracle | taint, not heuristics. Each seeded A row carries unique ids and a canary string. B's call passes if nothing of A's comes back and no A row changes |
| Read half | serialized output, plus every effect (mail, enqueued input, network body), searched for A's canaries and ids |
| Write half | `md5(t::text)` over the instance's A rows before and after, by the seed's own id list, so a child with no tenant column is covered |
| Cache | order: B, A as the positive control, B again. The second B catches an entry A filled under a key missing the tenant |
| Vacuous pass | A's positive control must be `reached`, or the row is `X_CONTRACT_EXERCISE_UNREACHED`. Deleting actions are why B runs first too |
| Public reads | a policy admitting anonymous is public by its own declaration: read half skipped and recorded, write half kept |
| `tenancy:cross` | B's actor gets a role granting the permission, never the cross capability |
| Same-tenant, other user | not here: ownership is a row predicate per app. Comes back as `peers:` on `defineExercise` once this ships clean |
| What it walks | `action`, `query` and `job`, the exercise pass's three lists, at run time; `entity` statically (step 1). A `mutator` only through the action calling it, a `policy` inside every call. **`route` and `task` are not walked**: a `page.tsx` `load` or a task handler reading raw SQL is outside this proof, and `wiki/Policies-And-Authz.md` says so |
| Which surface | `invoke` only: HTTP, client, job and MCP share it (`action/src/invoke.ts:77`, `mcp/src/cross-surface.test.ts`) |

## Files to change
- `packages/testing/src/tenant-proof.ts`, `tenant-canary.ts`, `tenant-proof-report.ts` (new). `testing/src/index.ts`.
- `packages/testing/src/seed-graph.ts` — canary per text column, per-instance id list.
- `packages/testing/src/exercise.ts` — runs the three legs after a primitive's seed.
- `packages/entity/src/entity.ts:53` — `shared?: string`, the reason a row references a tenant-owned table and belongs to no tenant. Blank refused at declaration.
- `packages/entity/src/describe.ts`, `packages/manifest/src/build.ts`, `manifest/src/diff-entities.ts` — carry and diff it; additive.
- `packages/cli/src/exercise-static.ts` (new) — the static half, under the `exercise` step. Not `policy`: `verify-step.ts:47` admits a rider only for that step's own question, which is whether a permission exists.
- `examples/dummy/apps/web/app/` — one `shared:` where the walk finds one, or a stated zero in the PR; the proof itself covers each action, query and job.
- `wiki/Policies-And-Authz.md` (section after `:134`, rows corrected), `wiki/Entities-And-Migrations.md`, `wiki/Testing.md`, `wiki/Error-Codes.md`, `packages/testing/{README,CLAUDE}.md`, `packages/entity/{README,CLAUDE}.md`.

## Steps
1. Static: an entity with no `$tenantColumn` whose reference path reaches a tenant-columned entity, and no `shared`, is a finding. The fix names both moves.
2. Canary rows through `seedGraph`. A column with a format that rejects a canary (uuid, enum) is tainted by its id alone.
3. Legs, per primitive: B with A's ids; A; B again. The two inputs differ only in which instance's ids they draw.
4. A primitive with no tenant-owned input still runs: an actor-derived list must not contain A's rows.
5. Report under the `exercise` step: primitive, leg, path of the canary in the output or table and id of the changed row. Bound values never appear; only canaries, which are seeded.
6. Prove the oracle with planted holes in test fixtures (below), then run both tracked apps. A real finding is fixed in that PR, not pinned.

## Error codes
`bun run new-error-code <CODE> --package testing …` (tier 5, neither flag); `X_ENTITY_TENANT_UNDECLARED` takes `--package entity --off-socket`.
| Code | When | Fix |
|---|---|---|
| `X_TENANT_LEAK` (new) | another tenant's canary reached an output or effect | `x exercise <name> --json`, then read through the scoped repo; `<name>` printed |
| `X_TENANT_WRITE_CROSSED` (new) | a call by B changed A's row | same; names table and id |
| `X_ENTITY_TENANT_UNDECLARED` (new) | a child of a tenant-owned table has no tenant | add `orgId: uuid().tenant()` then `x db gen "<table> tenant"`, or `shared: '<why>'` |

## Tests
- `testing/src/tenant-proof.test.ts` (unit), each hole planted in a fixture app and each must turn red: a child with no tenant; a raw-SQL read by input id; `crossTenant()` with no public policy; a service actor in a handler; a cache key without the tenant; a mail to A's address; a write by input id.
- Same file: a correctly scoped action and a public read stay green; a handler that always throws is `unreached`, not proven.
- `testing/src/tenant-proof.live.test.ts`: the hash leg on Postgres. `entity/src/entity.test.ts`: blank `shared`.
- `bun test packages/testing/src/tenant-proof.test.ts`.

## Semver
Breaking: a new red verdict on the `exercise` step. Upgrading: `x exercise --json`; each `X_ENTITY_TENANT_UNDECLARED` takes a tenant column (with a backfill, `x g backfill`) or `shared:`; each `X_TENANT_LEAK` is a real hole, a finding for the app's owner.

## Done when
- All seven planted holes red, each with the primitive named. The scoped and public fixtures green.
- The probe's child-table declaration fails `x verify`.
- Both tracked apps green with no pin, or their findings fixed in this PR.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
