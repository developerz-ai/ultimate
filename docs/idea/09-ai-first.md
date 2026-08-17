# AI-first

The differentiator. Not a chat widget, not an "AI SDK integration" — the framework is built so that an agent can read it, drive it, and verify its own work, and so that the apps it generates have the same property.

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
| `db.query` | **read-only** SQL, 100-row default and 1000-row maximum, `EXPLAIN` on request | inventing a query and hoping |
| `db.migrate` | generate + apply migrations **in a branch DB only** | mutating the dev database |
| `errors.explain` | `X_*` code → cause, fix command, docs URL | web search |
| `budgets.report` | per-route bytes/LCP with the import chain that caused a regression | bisecting bundles |

Read tools are unrestricted in dev. Write tools (`db.migrate`, `tests.run` with fixtures) are scoped to branch environments. The dev server is never exposed in `ROLE=web`.

`db.query` refuses structurally, before the host sees the string (`X_MCP_QUERY_REJECTED`): a batch, a non-read leading keyword, any statement-level write keyword — a data-modifying CTE included — a locking clause, `EXPLAIN ANALYZE`, or a call from a banned function family — reaching outside the database, taking a lock, changing a session setting or sleeping — matched by prefix of the called function name, quoted and schema-qualified spellings included, so the family is the unit and a spelling nobody wrote down is refused rather than admitted. Its Postgres role layer is conditional on the connection's own rights, so the answer's `guards` array names the defences that actually engaged.

## Generated facts, hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift is a `x verify` failure |
| `openapi.json` | **generated** | HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project-specific conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style, <600 lines |

**LLM-generated context files measurably reduce task success.** A model writing "here is what this codebase does" produces confident, plausible, partly-wrong prose, and the next agent treats it as ground truth — errors compound and cannot be distinguished from facts. So: facts come from code (structured, verifiable, regenerated every build), conventions come from a human (short, opinionated, stable). Ultimate never generates prose documentation at runtime, and `x new` scaffolds `AGENTS.md` as a terse human-editable stub, not an essay.

## Every action is an MCP tool

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration. From the existing declaration:

| MCP requirement | Source |
|---|---|
| tool name | the action's export name, verbatim — `publishPost`. One name across `tools/call`, `scopes:`, the LLM tool list and every published catalog; nothing derives a second spelling |
| JSON Schema for input | the action's `input` (Standard Schema → JSON Schema) |
| output schema | `output` |
| description | `mcp.description` |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical |
| audit trail | the same OTel span and log line as an HTTP call |

Authz for free means authz *identical*. An MCP call and an HTTP call reach the same `policy` with the same actor resolution. There is no MCP-specific permission table, no "trusted tool" mode, no service account with broad rights. Per [`02-primitives.md`](./02-primitives.md): two authz systems is how every Meteor-like framework died.

## The generated apps are AI-first too

The property that matters commercially: **the apps users build with Ultimate are themselves agent-drivable.**

```
packages/mcp/          # the app's own MCP tools
apps/admin/            # generated admin dashboard — exposes MCP over the app's actions
```

Every action a user writes with `mcp: { expose: true }` becomes a tool in *their* app's MCP surface, authenticated with *their* users' sessions and gated by *their* policies. So the user's own agents can operate the user's product — refund an order, re-run an import, publish a post — with the exact permissions that user has in the UI.

| Property | Consequence |
|---|---|
| Actor = the signed-in user's session | an agent can never exceed the human it acts for |
| Policies unchanged | no separate "API permissions" screen to get wrong |
| Admin dashboard ships with MCP on | day-one agent access to operations, not a v3 roadmap item |
| Tool list is generated | adding a feature adds a capability; deleting one removes it |

Competing frameworks make "add an AI feature" a project. Here it is the default state of the code you already wrote.

## LLM gateway primitive

One typed entry point for model calls — provider-agnostic, observable, cached, evaluated.

**`llm()` is an action factory, not a ninth primitive.** It returns an `action`, so a model
call carries the same MCP tool, OpenAPI operation, typed client, job handle and contract tests
every action does, gated by the same one policy object. A new capability arrives as a factory
over an existing primitive; the eight stay eight.

```ts
export const summarize = llm({
  model: 'claude-sonnet-5',
  input:  t.object({ postId: t.uuid, orgId: t.uuid }),   // orgId: the policy decides on it
  output: t.object({ summary: t.string, tags: t.array(t.string) }),
  prompt: summarizePrompt,                       // versioned artifact
  vars:   async ({ input, ctx }) => ({ body: await ctx.posts.body(input.postId) }),
  cache:  { semantic: { threshold: 0.97, ttl: '7d', scope: ({ orgId }) => orgId } },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: postRead,                              // declared once in the feature's policy.ts
});
```

Because `llm()` returns an `action`, every rule in [`02-primitives.md`](./02-primitives.md) applies
to it unchanged — including the two that bite hardest here. The policy object is **named**, never an
inline `can('post:read')`: the inline form carries the grant and drops the tenancy predicate, and
"summarise any post by id" is exactly the read that must not cross an org. And the declaration lives
in the feature's `actions.ts`, not beside the prompt — `prompts/` holds the artifact, its evals and
its baseline.

`scope` is not optional in a multi-tenant app: cosine similarity has no notion of a tenant, so one
shared semantic cache answers one org with another org's summary.

`vars` is the one declared place a model call loads data: the input is an id, the prompt needs
the row behind it, and a reader can see exactly what was sent.

| Feature | Behavior |
|---|---|
| Structured output | `output` schema drives tool-use/JSON mode; a parse failure retries once, then throws `X_LLM_OUTPUT_INVALID` |
| Streaming | first-class, wired to Solid signals and `stream` routes |
| Cost + token accounting | per call, per tenant, per prompt version; exceeding `budget` throws before spending |
| Retries | typed on provider errors; rate limits back off, content refusals do not retry |
| Caching | semantic cache from [`05-caching.md`](./05-caching.md) |
| Tracing | one OTel span per call with model, tokens, cache hit, prompt version |
| Fallback | ordered model list; a fallback is recorded in the span, never silent |
| Money | `Money = { minor, currency }` — never a float |

Long or multi-call chains are `job`s with steps ([`04-jobs.md`](./04-jobs.md)), so a model call that fails on step 4 retries step 4 only.

## Prompts as versioned artifacts

```
apps/web/app/posts/prompts/summarize.v3.md            # the prompt, plain markdown + typed slots
apps/web/app/posts/prompts/summarize.evals.ts         # evals attached to it
apps/web/app/posts/prompts/summarize.v3.baseline.json # the scores the gate compares against
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

`eval` is one of the six test types in [`10-testing.md`](./10-testing.md).

| Aspect | Detail |
|---|---|
| Shape | fixture set + assertions: exact, schema, rubric (LLM judge), or regression-vs-baseline |
| Determinism | temperature 0 where possible; judge model and prompt version pinned |
| Gate | `x verify` fails on a score drop beyond the declared tolerance, not on absolute score |
| Baseline | a committed file, so accepting a new number is a reviewable diff — `ULTIMATE_EVAL_RECORD=1 x test eval` re-records it |
| Coverage | a prompt no `defineEval` names fails the gate; the rule reads the registry, not filenames |
| Cost | reported per run; `x test eval --sample 20` for the fast local loop |
| Output | `--json` with per-case scores, so an agent iterating on a prompt sees which case it broke |

## Branch environments

The database half ships as `x db branch ls | create <name> | drop <name>`. `x branch` — the one command that also builds, routes and scopes a socket — is **planned** and exits `X_NOT_IMPLEMENTED`.

| Property | Detail | `As of 2026-08` |
|---|---|---|
| DB | `CREATE DATABASE "<source>_branch_<slug>" TEMPLATE "<source>"` copy-on-write clone — cheap, isolated, disposable. `<slug>` is `<name>` with every character outside `[A-Za-z0-9_]` replaced by `_`, because a hyphen is not legal in an unquoted Postgres identifier: `create feat-new-billing` clones into `<source>_branch_feat_new_billing`. Embedded: a copied `pgdata-<name>` directory, which keeps the name **as typed** | **shipped** |
| Migrations | `db.migrate` applies here, never to the shared dev DB | **shipped** |
| Preview URL | `http://<name>.localhost:<PORT>`, reported on `data.preview` | **computed**, routed by nothing |
| Teardown | `x db branch drop <name>` — only what `x db branch ls` shows | **shipped** |
| **Build ID scopes the SW** | the branch gets its own SW scope and cache namespace, so a preview can never poison prod cache ([`08-pwa-offline.md`](./08-pwa-offline.md)) | **planned** |
| Agent use | an agent can migrate, seed, test, and browse a preview without risking anything shared | |

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

An agent that can parse the failure and read the fix command closes the loop without a human. That is the whole thesis, made operational.
