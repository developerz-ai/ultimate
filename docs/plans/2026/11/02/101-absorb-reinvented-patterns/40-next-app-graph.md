# 40-next-app-graph — `x graph` and `x impact`: the app as one typed graph

> Part of [`overview.md`](overview.md). Depends on: none for the declared half; [`40-next-exercise-pass.md`](40-next-exercise-pass.md) phase 2 for observed edges. Tier: 4 (`manifest`, `mcp`), 5 (`cli`).

## Why
An agent's costliest step is reading files to learn what an edit touches, and its costliest mistake is missing one. The facts exist, unjoined. `examples/dummy/x.manifest.json` lists 57 routes, 32 actions, 12 queries, 14 jobs, 12 entities, 45 policies: a route row names no query and an action row no entity. The manifest answers "what exists", never "what depends on what".
`x affected` closes over workspaces (`cli/src/affected.ts:36`): an app's slices share `apps/web`, so one edit there selects all of its tests. The dev MCP server has `routes.list`, `actions.describe`, `manifest.read` and nothing that joins them (`mcp/src/dev-server.ts:252`).
Hard to match: a closed vocabulary. A generic code graph sees files and symbols; this one has edges such as "this action invalidates the tag this page reads and this MCP tool exposes". No other framework can type them, because in other frameworks these are conventions, not values.

## Decisions
| Question | Answer |
|---|---|
| Nodes | route, action, mutator, query, job, task, entity, policy, permission, channel, cache tag, MCP tool, published operation, catalog key, source file, test file |
| Edge provenance | every edge says `declared` (registry), `import` (module graph) or `observed` (the exercise pass). An agent sees what it can trust |
| Static call analysis | no. No compiler API in the CLI, and a guessed edge is worse than a missing one. `observed` gives handler to entity and to job from a real run |
| Stored? | no. Rebuilt per call from a load the CLI already does (`cli/src/app-load.ts:247`), cached under `.x/`. Not in `x.manifest.json`: a contract that would churn on every import |
| `x plan` | killed: `x g <kind> --dry-run` already prints the plan (`cli/src/cmd-generate-spec.ts:29`) |
| Column-level impact | no. `x impact posts` is entity-level; a column's reach comes from the typecheck, which is exact (`docs/idea/13-dx.md:162`) |
| Test selection soundness | a superset by construction: a test runs unless its import closure misses every changed file. A computed `import()` marks its file `opaque`; dependents of an opaque file are all selected |
| Replaces the gate? | no. `x test --affected` is the inner loop; `x verify` still runs everything (axiom 5) |
| A new `--impact` flag | a second way. `--affected` narrows by import closure inside a workspace and keeps its name |

## Files to change
- `packages/manifest/src/graph.ts` (new) — pure: manifest plus import edges to a graph; `impactOf(graph, node)`, `pathBetween`.
- `packages/manifest/src/graph-schema.ts` (new) — public types; `graphVersion`. `manifest/src/index.ts`.
- `packages/cli/src/app-module-graph.ts` (new) — `scanAllImports` (`cli/src/import-scan.ts:74`) over the app's files.
- `packages/cli/src/app-load.ts:168` — `AppScan` gains `primitives: { kind, name, file }[]`, from what each `register` call took; today it records only `files`, so nothing maps a primitive to its file.
- `packages/cli/src/affected.ts:36`, `cmd-test.ts`, `cmd-test-spec.ts:49` — in an app root, `--affected` selects by closure. `cmd-affected.ts` adds `tests`.
- `packages/cli/src/cmd-graph.ts`, `cmd-graph-spec.ts`, `cmd-impact.ts`, `cmd-impact-spec.ts` (new), `registry.ts`.
- `packages/mcp/src/dev-server.ts:252`, `packages/cli/src/mcp-host.ts` — one tool, `graph.query`, three encodings per `docs/idea/13-dx.md:91`.
- `packages/cli/src/templates/scaffold-docs.ts`, `scaffold-claude.ts` — one line: before an edit, `x impact <file> --json`.
- `wiki/CLI-Reference.md`, `wiki/MCP-And-AI.md`, `wiki/Testing.md`, `wiki/Error-Codes.md`, `docs/idea/09-ai-first.md`, `llms.txt`, `packages/manifest/{README,CLAUDE}.md`, `packages/cli/{README,CLAUDE}.md`.

## Steps
1. Graph over `examples/dummy/x.manifest.json`, pure. Declared edges: `policy`, `permissions`, `cacheInvalidates`, `cacheTags`, `enqueues`, `mcp.expose`, `revalidateTags`, `references`.
2. Module edges: primitive to file, file to file, test to file. `x graph --json`.
3. `x impact <file|primitive|entity> [--json]`: `{ routes, actions, queries, jobs, mcpTools, publishedOperations, tests, budgets, opaque, provenance }`. `publishedOperations` non-empty says `contract-diff` will have an opinion.
4. `x graph --from <a> --to <b>`: the path, or an answer that none is known and which provenance was searched.
5. Read `.x/exercise.json` when present and add `observed` edges; a stale file is ignored by build id.
6. `--affected` by closure; root-wide files (`affected.ts` already names them) select everything.
7. Measure on both tracked apps: files selected for a one-slice edit, before and after; state both in the PR.

## Error codes
`bun run new-error-code <CODE> --package cli …` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_GRAPH_NODE_UNKNOWN` (new) | a name or path matches no node; nearest three listed | `x graph --json \| jq '.data.nodes[].id'` |

## Tests
- `manifest/src/graph.test.ts` (unit): each edge kind from a fixture manifest; impact is transitive; a deleted edge changes the answer.
- `cli/src/app-module-graph.test.ts`: type-only imports count (a type change can break a test); a computed import is `opaque`.
- `cli/src/cmd-impact.test.ts`, on a scaffold: editing a query names its route and its MCP tool.
- Soundness, `cli/src/affected-closure.test.ts`: on a scaffold, break each of N modules in turn; the selection must contain a test that fails. A miss fails the test.
- `bun test packages/manifest/src/graph.test.ts`.

## Semver
Minor. New commands, new MCP tool. `--affected` selects fewer files in an app root and stays a superset of what can break: a run is narrower, never a new red verdict.

## Done when
- `x impact` on a query in `examples/dummy` names its route, its MCP tool and its tests, each with provenance. Wall time stated in the PR.
- The soundness test holds on both tracked apps' slices.
- A one-slice edit selects under half of `apps/web`'s tests on both tracked apps, or the PR says why not.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
