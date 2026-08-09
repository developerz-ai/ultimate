# MCP and AI

The differentiator. Not a chat widget, not an "AI SDK integration" — the framework is built so an agent can read it, drive it, and verify its own work, and so the apps it generates have the same property.

Pre-v1, not production-ready. `As of 2026-07`: the MCP registry, wire protocol, dev-tool catalog, read-only SQL guard, and action projection are built; the `llm()` gateway, prompt versioning, vector search, and eval runner are contracted and partially implemented.

## Built-in MCP dev server

`x dev` starts an MCP server on the dev socket. Point Claude Code (or any MCP client) at it and the agent stops guessing.

| Tool | Introspects / does | Replaces the agent's usual guess |
|---|---|---|
| `routes.list` | route table: path, render mode, hydrate, offline, budget, meta status | grepping a router directory |
| `schema.describe` | tables, columns, types, indexes, FKs, invariants | reading migration files in order |
| `policies.list` | every `policy`, which actions/queries use it, its denial reason | "is this endpoint protected?" |
| `actions.list` | inputs, outputs, tags, MCP exposure | reading `api/` by hand |
| `manifest.get` | the whole `x.manifest.json` | ten separate reads |
| `tests.run` | run a test type or a single file, structured results | parsing terminal output |
| `logs.tail` | structured logs + OTel spans, filterable | scrollback archaeology |
| `db.query` | **read-only** SQL, 1000-row cap, `EXPLAIN` on request | inventing a query and hoping |
| `db.migrate` | generate + apply migrations **in a branch DB only** | mutating the dev database |
| `errors.explain` | `X_*` code → cause, fix command, docs URL | web search |
| `budgets.report` | per-route bytes/LCP with the import chain that caused a regression | bisecting bundles |

Implemented names `as of 2026-07` differ slightly from the design table: `actions.describe` (actions + queries in one call), `manifest.read`, `jobs.inspect`, `queue.depth`, `verify.run`. Aliases land before v1.

| Class | Tools | Exposure |
|---|---|---|
| read | `routes.list`, `schema.describe`, `policies.list`, `actions.list`, `manifest.get`, `errors.explain` | unrestricted in dev |
| gated read | `db.query`, `logs.tail`, `budgets.report` | scope `db:read` / `dev:logs` |
| write | `db.migrate`, `tests.run` | scope `db:migrate` / `dev:test`, **branch environments only** |

None of them is exposed in `ROLE=web`. `db.query` accepts one statement. Multiple statements, writes, locking clauses, and data-modifying CTEs are **refused**, not discouraged — `X_MCP_QUERY_REJECTED`, enforced before the host sees the string. `db.migrate` refuses a target that is not a branch database — `X_MCP_NOT_BRANCH_DB`.

## Every action is an MCP tool

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration. From the existing declaration:

| MCP requirement | Source |
|---|---|
| tool name | action name |
| JSON Schema for input | the ArkType `input` (Standard Schema → JSON Schema) |
| output schema | `output` |
| description | `mcp.description` |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical |
| audit trail | the same OTel span and log line as an HTTP call |

The projected tool calls `action.run(...)` — the same entry point the HTTP route calls. Policy runs inside `run`, so there is nothing to keep in sync. A projected tool therefore declares **no** MCP scope: adding one would be a second gate in front of the only gate that matters, and the two would eventually disagree.

No MCP-specific permission table, no service account with broad rights. Exposure is opt-in; silence exposes nothing.

The user's own agents can therefore operate the user's product — refund an order, re-run an import, publish a post — with the exact permissions that user has in the UI. See [Admin dashboard](Admin-Dashboard) and [Actions](Actions).

## Three outcomes, deliberately different

Role, scope and policy refuse in three distinguishable ways. The difference is the security property, not an implementation detail.

| Situation | Response | Wire |
|---|---|---|
| The actor's role can never invoke the tool | absent from `tools/list`; a direct call answers ToolNotFound | JSON-RPC `-32601`, message `tool not found: <name>`, no `data` at all |
| The role could invoke it, but the connection's scope does not include it | explicit refusal naming the missing scope | JSON-RPC `-32600`, `data: { code: 'X_MCP_SCOPE_DENIED', scope, fix }` |
| The tool was invoked and the policy denied this input | `X_POLICY_DENIED` with the denial reason | a normal `result` with `isError: true` — identical to the HTTP answer for the same call |

Hidden means hidden: `Forbidden` on a hidden tool is an enumeration oracle — an agent, or an attacker driving one, walks a name list and reads the org's feature set, entity names and internal operations off the difference between "not found" and "forbidden". A scope refusal is the opposite case: a well-behaved client can legitimately fix it, so hiding it would only strand the caller.

| Rule | Detail |
|---|---|
| Visibility is **fail-closed** | a tool that declares `visibleTo` is visible only to a caller whose role is in the list; a caller with no role sees only tools that declare no `visibleTo` |
| `tools/list` is per connection | answered per caller, never a static catalog |
| Visibility is input-independent | `visibleTo` is a role list or a predicate over the caller — the predicate never sees call arguments, so existence cannot be probed by varying them |
| Gate order is fixed | visibility → scope → arguments → policy. Scope runs before the policy, so a refusal never depends on evaluating a policy against attacker-supplied input; arguments are validated after both gates, so a schema never leaks to a caller who may not see the tool |
| Every outcome is audited | one structured log line per `tools/call`: `surface: 'mcp'`, tool name, actor id, outcome. ToolNotFound, scope denials and policy denials log at `warn`, a successful call at `info` — ToolNotFound is `warn` on purpose, because an enumeration attempt is a detectable pattern |
| Audit lines carry no payload | tool name, outcome and error code only — never call arguments, never row data |
| No trusted-tool mode | there is no flag that skips policy evaluation, on any MCP surface |
| The actor cannot exceed the human | the actor is the signed-in user's session; an agent inherits exactly those permissions |

Rationale for each: [`docs/architecture/11-ai-surface.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/11-ai-surface.md).

## Generated facts, hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift is a `x verify` failure |
| `openapi.json` | **generated** | HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project-specific conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style, <600 lines |

LLM-generated context files measurably reduce task success. A model writing "here is what this codebase does" produces confident, plausible, partly-wrong prose, and the next agent treats it as ground truth — errors compound and cannot be distinguished from facts. So: facts come from code (structured, verifiable, regenerated every build), conventions come from a human (short, opinionated, stable). Ultimate never generates prose documentation at runtime, and `x new` scaffolds `AGENTS.md` as a terse human-editable stub, not an essay.

## LLM gateway

One typed entry point for model calls — provider-agnostic, observable, cached, evaluated.

```ts
export const summarize = llm({
  model: 'claude-sonnet-4-5',
  input:  t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.string.array() }),
  prompt: summarizePrompt,                       // versioned artifact
  cache:  { semantic: { threshold: 0.97, ttl: '7d' } },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: can('post:read'),
});
```

| Feature | Behavior |
|---|---|
| Structured output | `output` schema drives tool-use/JSON mode; a parse failure retries once, then throws `X_LLM_OUTPUT_INVALID` |
| Streaming | first-class, wired to Solid signals and `stream` routes |
| Cost + token accounting | per call, per tenant, per prompt version; exceeding `budget` throws before spending |
| Retries | typed on provider errors; rate limits back off, content refusals do not retry |
| Caching | semantic cache from [Caching and invalidation](Caching-And-Invalidation) |
| Tracing | one OTel span per call with model, tokens, cache hit, prompt version |
| Fallback | ordered model list; a fallback is recorded in the span, never silent |
| Money | `Money = { minor, currency }` — never a float → [Money](Money) |

Long or multi-call chains are `job`s with steps, so a model call that fails on step 4 retries step 4 only. See [Jobs and workflows](Jobs-And-Workflows).

## Prompts as versioned artifacts

```
apps/web/app/posts/prompts/summarize.v3.md      # the prompt, plain markdown + typed slots
apps/web/app/posts/prompts/summarize.evals.ts   # evals attached to it
```

| Rule | Why |
|---|---|
| A prompt is a file with a version, not a string literal | diffable, reviewable, attributable in traces |
| Editing a prompt requires a version bump | invalidates the semantic cache; keeps A/B honest |
| Slots are typed | a missing variable is a compile error, not a `{{undefined}}` in production |
| **Every prompt has an evals file** — no evals is a `x verify` failure | an unevaluated prompt is untested code |
| Old versions retained | traces stay interpretable; rollback is a config line |

## Vectors and hybrid search

pgvector in the same Postgres. No second datastore.

| Piece | Detail |
|---|---|
| Embeddings | declared on an entity: `embed: { field: 'body', model: 'text-embedding-3-large' }` |
| Backfill | generated as a `job` with steps, resumable, rate-limited per tenant |
| Index | HNSW, created by the generated migration |
| Hybrid search | one `query` primitive fusing pgvector cosine + Postgres FTS with Reciprocal Rank Fusion; weights are config |
| Filtering | tenant + policy filters applied **in SQL**, so vector search cannot leak across tenants |
| Re-embed | content-hash change triggers a job; unchanged text is never re-embedded |

## Evals as a test type

`eval` is one of the six test types in [Testing](Testing).

| Aspect | Detail |
|---|---|
| Shape | fixture set + assertions: exact, schema, rubric (LLM judge), or regression-vs-baseline |
| Determinism | temperature 0 where possible; judge model and prompt version pinned |
| Gate | `x verify` fails on a score drop beyond the declared tolerance, not on absolute score |
| Cost | reported per run; `x test eval --sample 20` for the fast local loop |
| Output | `--json` with per-case scores, so an agent iterating on a prompt sees which case it broke |

## Branch environments

```
x branch feat-new-billing
  ✓ database    myapp_feat_new_billing   (copy-on-write from dev template, 340ms)
  ✓ build       build id 8f2a1c…
  ✓ preview     http://feat-new-billing.localhost:3000
  ✓ mcp         ws://localhost:9229/feat-new-billing
```

| Property | Detail |
|---|---|
| DB | `CREATE DATABASE ... TEMPLATE` copy-on-write clone — cheap, isolated, disposable |
| Migrations | `db.migrate` applies here, never to the shared dev DB |
| Preview URL | routed by subdomain; same image, `ROLE=web` |
| **Build ID scopes the SW** | the branch gets its own SW scope and cache namespace, so a preview can never poison prod cache → [PWA and offline](PWA-And-Offline) |
| Teardown | `x branch rm feat-new-billing`, or automatic on branch delete |
| Agent use | an agent can migrate, seed, test, and browse a preview without risking anything shared |

## `--json` everywhere

Every command and every error has a machine-readable form. Same content, different encoding.

```
$ x verify --json
{"ok":false,"checks":[{"name":"budgets","ok":false,"failures":[
  {"route":"site/pricing","metric":"js","actual":"61kb","limit":"40kb",
   "cause":"chart.js via shared/ui/button.tsx",
   "fix":"x fix boundary site/pricing/page.tsx"}]}]}
```

| Surface | Machine form |
|---|---|
| CLI | `--json` on every subcommand |
| Errors | `UltimateError` serializes to `{ code, cause, fix, docs }` |
| HTTP errors | same JSON body, same codes |
| Dev overlay | the identical string a terminal shows |
| MCP | tool errors carry the same code + fix |

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_MCP_TOOL_UNKNOWN` | no visible tool answers that name (role-hidden and absent are indistinguishable) | `tools/list` to read the catalog this caller may use |
| `X_MCP_ARGS_INVALID` | arguments failed the tool's declared JSON Schema | re-read `inputSchema` from `tools/list` and resend |
| `X_MCP_SCOPE_DENIED` | the connection's token does not carry the tool's scope | `x token grant <scope>`, then reconnect — scopes are fixed for the life of a connection |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given one read-only statement | send a single `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` pointed at a database that is not a branch | use a branch DB (`x branch <name>`) |
| `X_MCP_PROTOCOL` | malformed envelope or unsupported method — a client bug, not an authz outcome | send a JSON-RPC 2.0 body |
| `X_POLICY_DENIED` | the action's policy refused this actor — identical to the HTTP denial | grant the permission, or act as an actor who has it |
| `X_LLM_OUTPUT_INVALID` | model output failed the `output` schema twice | tighten the prompt or widen the schema; bump the prompt version |
| `X_NOT_IMPLEMENTED` | a remote driver stub was reached | configure the local/PGlite driver, or wait for the release named in `fix` |

Full list: [Error codes](Error-Codes). CLI surface: [CLI reference](CLI-Reference).

## Rules

- One authz system. An MCP call and an HTTP call reach the same `policy` with the same actor resolution.
- Exposure is opt-in per action; a projected tool carries no scope of its own.
- Visibility is fail-closed and computed per connection. A hidden tool answers ToolNotFound, never Forbidden.
- Gate order is visibility → scope → arguments → policy, and every outcome is audited. There is no trusted-tool mode.
- Write tools are branch-scoped. The dev server is never reachable in `ROLE=web`.
- Facts are generated every build; conventions are hand-written and short.
- Never generate prose documentation at runtime.
- Every command and every error has a `--json` form; budgets throw before spending, in `Money`.
- Every prompt is a versioned file with an evals file.

Source: [`packages/mcp/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/mcp/src)
