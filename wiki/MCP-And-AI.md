# MCP and AI

The differentiator. Not a chat widget, not an "AI SDK integration" — the framework is built so an agent can read it, drive it, and verify its own work, and so the apps it generates have the same property.

v1.0.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). The MCP registry, wire protocol, dev-tool catalog, read-only SQL guard, and action projection are built, and so are the four that used to be contracted: `llm()` is an action factory ([`packages/ai/src/llm.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/llm.ts)), prompts are versioned, `PgVectorStore` fuses pgvector cosine with Postgres FTS via RRF, and evals gate on a committed baseline inside `x verify`'s `eval` step.

## Built-in MCP dev server

`x dev` starts an MCP server on the dev socket. Point Claude Code (or any MCP client) at it and the agent stops guessing.

Thirteen tools `As of 2026-08` — the whole catalog, spelled exactly as they must be called. No aliases; renaming one is a major.

| Tool | Introspects / does | Replaces the agent's usual guess |
|---|---|---|
| `routes.list` | route table: url, render mode, hydrate, offline, budget | grepping a router directory |
| `schema.describe` | entities with columns, types and invariants | reading migration files in order |
| `policies.list` | every `policy`: permission, subject, where it is enforced | "is this endpoint protected?" |
| `actions.describe` | every action **and query**: input/output schema, policy, cache tags, MCP exposure | reading `api/` by hand |
| `jobs.inspect` | job definitions, retry policy and steps; omit `name` for all | reading `jobs.ts` and guessing the retry |
| `queue.depth` | pending, running and failed counts per queue | tailing a worker to see if it keeps up |
| `manifest.read` | the whole `x.manifest.json`, as text | ten separate reads |
| `errors.explain` | `X_*` code → cause, exact fix command, docs URL | web search |
| `db.query` | **read-only** SQL, 100-row default and 1000-row maximum, `EXPLAIN` on request | inventing a query and hoping |
| `db.migrate` | apply pending migrations **in a branch DB only** | mutating the dev database |
| `tests.run` | run the suite or a substring filter, structured results | parsing terminal output |
| `verify.run` | the whole gate; `fix: true` applies safe autofixes | guessing whether the work is shippable |
| `logs.tail` | last N structured log lines, filterable by runtime role | scrollback archaeology |

| Class | Tools | Exposure |
|---|---|---|
| read | `routes.list`, `schema.describe`, `policies.list`, `actions.describe`, `jobs.inspect`, `queue.depth`, `manifest.read`, `errors.explain` | scope `dev:read`, unrestricted in dev |
| gated read | `db.query`, `logs.tail` | scope `db:read` / `dev:logs` |
| executes code | `tests.run`, `verify.run` | scope `dev:test`; both declare `destructive: true`, so neither is metered as read chatter |
| write | `db.migrate` | scope `db:migrate`, **branch environments only** |

None of them is exposed in `ROLE=web`. `db.query` accepts one statement, whose leading keyword must be `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — necessary, never sufficient. Batches, any write keyword at statement level (a data-modifying CTE included), locking clauses (`FOR UPDATE`/`FOR SHARE`), `EXPLAIN ANALYZE`, and whole function families matched by prefix of the called name, quoted and schema-qualified spellings included — file access (`pg_read_*`, `pg_ls_*`, `lo_*`, `dblink`), locks (`pg_advisory_*`), session settings (`set_config`) and sleeps (`pg_sleep*`) — are **refused**, not discouraged — `X_MCP_QUERY_REJECTED`, enforced before the host sees the string. Its Postgres SELECT-only role is conditional on the connection's own rights; the answer's `guards` array names the defences that engaged. `db.migrate` refuses a target that is not a branch database — `X_MCP_NOT_BRANCH_DB`.

## Every action is an MCP tool

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration. From the existing declaration:

| MCP requirement | Source |
|---|---|
| tool name | action name |
| JSON Schema for input | the `input` schema (Standard Schema → JSON Schema, via `introspect()`) |
| output schema | `output` |
| description | `mcp.description` |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical |
| audit trail | the same OTel span and log line as an HTTP call |

The projected tool calls `action.run(...)` — the same entry point the HTTP route calls. Policy runs inside `run`, so there is nothing to keep in sync. The projection itself adds **no** MCP scope: a second gate hard-coded into the projection would sit in front of the only gate that matters, and the two would eventually disagree. `defineAppMcp`'s `scopes:` map may still attach one from outside — a property of the connection's token, never invented by the projection.

No MCP-specific permission table, no service account with broad rights. Exposure is opt-in; silence exposes nothing.

The user's own agents can therefore operate the user's product — refund an order, re-run an import, publish a post — with the exact permissions that user has in the UI. See [Admin dashboard](Admin-Dashboard) and [Actions](Actions).

## Three outcomes, deliberately different

Role, scope and policy refuse in three distinguishable ways. The difference is the security property, not an implementation detail.

| Situation | Response | Wire |
|---|---|---|
| The actor's role can never invoke the tool | absent from `tools/list`; a direct call answers ToolNotFound | JSON-RPC `-32601`, message `tool not found: <name>`, no `data` at all |
| The role could invoke it, but the connection's scope does not include it | explicit refusal naming the missing scope | JSON-RPC `-32600`, `data: { code: 'X_MCP_SCOPE_DENIED', scope, fix }` |
| The tool was invoked and the policy denied this input | `X_FORBIDDEN` with the denial reason | a normal `result` with `isError: true` — identical to the HTTP answer for the same call |

Hidden means hidden: `Forbidden` on a hidden tool is an enumeration oracle — an agent, or an attacker driving one, walks a name list and reads the org's feature set, entity names and internal operations off the difference between "not found" and "forbidden". A scope refusal is the opposite case: a well-behaved client can legitimately fix it, so hiding it would only strand the caller.

| Rule | Detail |
|---|---|
| `visibleTo` takes two forms | a **role allowlist**, or a **predicate over the caller**. A tool that declares neither is visible to everyone |
| Both forms are **fail-closed** | a role list admits only the roles it names, so a caller whose role is not in it — including a caller with no role at all — is refused; a caller with no role sees only tools that declare no `visibleTo` |
| `tools/list` is per connection | answered per caller, never a static catalog |
| Visibility is input-independent | the predicate takes the caller and nothing else — it structurally cannot read call arguments, so existence cannot be probed by varying them |
| Gate order is fixed | visibility → scope → arguments → policy. Scope runs before the policy, so a refusal never depends on evaluating a policy against attacker-supplied input; arguments are validated after both gates, so a schema never leaks to a caller who may not see the tool |
| Every outcome is audited | one structured log line per `tools/call`: `surface: 'mcp'`, tool name, actor id, outcome. ToolNotFound, scope denials and policy denials log at `warn`, a successful call at `info` — ToolNotFound is `warn` on purpose, because an enumeration attempt is a detectable pattern |
| Audit lines carry no payload | tool name, outcome and error code only — never call arguments, never row data |
| No trusted-tool mode | there is no flag that skips policy evaluation, on any MCP surface |
| The actor cannot exceed the human | the actor is the signed-in user's session; an agent inherits exactly those permissions |

Where the first two outcomes are declared:

| Outcome | Declared | Property |
|---|---|---|
| Hidden (role) | `mcp: { visibleTo: [...] }`, on the action or query itself | `readonly string[]` — a role allowlist. A primitive declares the list form only: a declared fact stays static and serialisable. The predicate form of `McpVisibility` is for a surface that builds its catalog programmatically (`@ultimat3/admin` derives visibility from the actor's admin permissions) and hands `@ultimat3/mcp` a tool directly. Both are fail-closed: an unnamed role — including a caller carrying no role at all — gets ToolNotFound, never Forbidden. A catalog audience, not an authz rule; the primitive's `policy` still decides every call |
| Scope | `scopes:` on `defineAppMcp` | `Readonly<Record<string, readonly string[]>>` — scope name → tool names. A capability of the connection's token, so it is declared once per app rather than beside every primitive. A name the catalog does not contain, or one claimed by two scope entries, refuses at boot: `X_MCP_SCOPE_UNKNOWN`, `X_MCP_SCOPE_CONFLICT` |

Rationale for each: [`docs/architecture/11-ai-surface.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/11-ai-surface.md).

## Generated facts, hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift is a `x verify` failure |
| `openapi.json` | **generated** | HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project-specific conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style, <600 lines | never generated, never auto-appended |

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
| `X_MCP_SCOPE_UNKNOWN` | `defineAppMcp`'s `scopes:` names a tool the server does not project | spell the name as one of the tools the server actually projects, or drop it from that `scopes` entry |
| `X_MCP_SCOPE_CONFLICT` | two `scopes:` entries claim the same tool | keep the tool under the single scope a token must hold for it, and remove the other entry |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given one read-only statement | send exactly one **read-only** `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — a data-modifying CTE is not a read |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` pointed at a database that is not a branch | use a branch DB (`x branch <name>`) |
| `X_MCP_PROTOCOL` | malformed envelope or unsupported method — a client bug, not an authz outcome | send a JSON-RPC 2.0 body |
| `X_FORBIDDEN` | the action's policy refused this actor — identical to the HTTP denial | call `policies.list` for the permission this tool enforces, then grant it to the actor's role in `apps/web/shared/policies.ts` |
| `X_LLM_OUTPUT_INVALID` | model output failed the `output` schema twice | tighten the prompt or widen the schema; bump the prompt version |
| `X_NOT_IMPLEMENTED` | a remote driver stub was reached | configure the local/PGlite driver, or wait for the release named in `fix` |

Full list: [Error codes](Error-Codes). CLI surface: [CLI reference](CLI-Reference).

## Rules

- One authz system. An MCP call and an HTTP call reach the same `policy` with the same actor resolution.
- Exposure is opt-in per action; the projection carries no scope of its own — `defineAppMcp`'s `scopes:` map may still attach one, from outside the primitive.
- Visibility is fail-closed and computed per connection. A hidden tool answers ToolNotFound, never Forbidden.
- Gate order is visibility → scope → arguments → policy, and every outcome is audited. There is no trusted-tool mode.
- Write tools are branch-scoped. The dev server is never reachable in `ROLE=web`.
- Facts are generated every build; conventions are hand-written and short.
- Never generate prose documentation at runtime.
- Every command and every error has a `--json` form; budgets throw before spending, in `Money`.
- Every prompt is a versioned file with an evals file.

Source: [`packages/mcp/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/mcp/src)
