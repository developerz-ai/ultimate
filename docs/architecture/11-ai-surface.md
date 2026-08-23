# AI surface

The differentiator, as internals. Product rationale: [`../idea/09-ai-first.md`](../idea/09-ai-first.md).

## One `evaluate`, two adapters

An action is not "also exposed over MCP". There is one invocation core; HTTP and MCP are thin adapters over it.

```ts
// packages/action/src/invoke.ts — the single invocation core
export function invoke(target: AnyAction, raw: unknown, options: InvokeOptions = {}) {
  const def = defOf(target);                                 // private store, this module only
  const input = await validateInput(def.input, raw, name);   // X_INPUT_INVALID
  guard(def.policy, { actor: actorOf(ctx), input, ctx, action: name }, options.surface);
  const out = await def.handle({ input, ctx });              // policy's own code on denial
  return validateOutput(def.output, out, name);              // X_OUTPUT_INVALID
}
```

| Adapter | Turns | Into | Then |
|---|---|---|---|
| `http` | a `Request` body | `raw` | `invoke(action, raw, { surface: 'http' })` |
| `mcp` | a `tools/call` `arguments` object | `raw` | `invoke(action, raw, { surface: 'mcp', actor })` |

`surface` selects how a denial renders — never whether authz runs. The actor rides in on `options` (or on the ambient context); `.as(actor, input)` is the same core with the actor swapped, not a second path.

Neither adapter may parse, authorize, or handle on its own. Both go through `invoke`. Enforced structurally: an action has no `.def`. The declaration lives in a private store inside `invoke.ts` and `@ultimat3/action` exports no reader for it, so `handle` has exactly one caller.

| MCP requirement | Source | Notes |
|---|---|---|
| tool name | the action's export name, verbatim | `publishPost` — the name `scopes:` and `tools/call` address, and the one an author greps for. **Every publisher agrees `As of 2026-08`**: `x-ultimate.mcpTool`, `describe().mcp.tool` and `.tool().name` snake-cased it through a `toToolName` that no longer exists, so `openapi.json` advertised 15 tools this server answers ToolNotFound for across the two tracked apps — every multi-word export name of the 17 it publishes. `packages/mcp/src/cross-surface.test.ts` is the enforcement — it calls `tools/call` with the name OpenAPI published |
| input JSON Schema | the action's `input` via Standard Schema → JSON Schema | the same schema HTTP parses |
| output schema | `output` | same |
| description | `mcp.description` | required when `expose: true` |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical | one authz system |
| actor | the session behind the MCP connection | never a service account with broad rights |
| audit | the same OTel span and structured log line as an HTTP call | `surface: 'mcp'` attribute is the only difference |

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration. Two authz systems is how every Meteor-like framework died ([`../idea/02-primitives.md`](../idea/02-primitives.md)).

## MCP dev server

`x dev` starts an MCP server on the dev socket. Never exposed in `ROLE=web`.

**Thirteen tools, `As of 2026-08`** — the whole catalog, declared once in `devTools(host)`
([`packages/mcp/src/dev-server.ts`](../../packages/mcp/src/dev-server.ts)) so `x mcp serve` and the
HTTP transport share it. The names below are the names `tools/call` accepts; there are no aliases,
and renaming one is a major.

| Tool | Scope | Reads / does |
|---|---|---|
| `routes.list` | `dev:read` | route table: url, render mode, offline strategy, hydrate, budget |
| `schema.describe` | `dev:read` | entities with columns, types and invariants |
| `policies.list` | `dev:read` | every policy: permission, subject, and where it is enforced |
| `actions.describe` | `dev:read` | every action **and query**: input/output schema, policy, cache tags, MCP exposure |
| `jobs.inspect` | `dev:read` | job definitions, retry policy and steps; omit `name` for all |
| `queue.depth` | `dev:read` | pending, running and failed counts per queue |
| `manifest.read` | `dev:read` | the whole `x.manifest.json`, as text |
| `errors.explain` | `dev:read` | `X_*` → cause, exact fix command, docs URL |
| `db.query` | `db:read` | **one read-only** SQL statement, row and byte caps, `EXPLAIN` on request |
| `db.migrate` | `db:migrate` | apply pending migrations, **branch DB only** |
| `tests.run` | `dev:test` | run the suite or a substring filter, structured results |
| `verify.run` | `dev:test` | the whole gate; `fix: true` applies safe autofixes |
| `logs.tail` | `dev:logs` | last N structured log lines, filterable by runtime role |

`read()` stamps `scope: dev:read` and `destructive: false` on the first eight; `tests.run` and
`verify.run` declare `destructive: true`, so neither is metered as read chatter. Read tools are
unrestricted in dev. Write tools are scoped to branch environments.

Four tools this table named until 2026-08 and the server has never projected: `actions.list`
(it is `actions.describe`), `manifest.get` (`manifest.read`), `budgets.report`, `live.explain`, and
the `jobs.list`/`jobs.status`/`jobs.retry` triple (one tool, `jobs.inspect`). `queue.depth` and
`verify.run` ship and were absent. An agent that trusted the old table called five tools this
server answers ToolNotFound for.

## Security posture

Three distinct outcomes, deliberately different:

| Situation | Response | Why |
|---|---|---|
| Actor's **role** can never invoke this tool | the tool is **absent from `tools/list`**, and a direct call answers `ToolNotFound` | a `Forbidden` answer confirms the tool exists |
| Actor's role could invoke it, but the **connection's scope** does not include it | explicit refusal: `X_MCP_SCOPE_DENIED`, naming the missing scope + `fix: reconnect with scope <name>` | the caller can legitimately fix this; hiding it would strand a well-behaved client |
| Tool invoked, but the **policy denies this input** | `X_FORBIDDEN` with the denial reason | identical to the HTTP answer for the same call |

Each outcome is declared in exactly one place:

| Outcome | Declared by |
|---|---|
| 1 — hidden (role) | `mcp: { visibleTo: [...] }` on the action or query; an `McpVisibility` predicate for a programmatic surface that derives visibility from something richer than a role name |
| 2 — scope | `scopes:` on `defineAppMcp` — scope name → the tool names that capability covers, never on the primitive |
| 3 — policy | the primitive's own `policy`, unchanged |

A projection invents no scope of its own: `toolFromAction` never sets one, because a scope is a capability of the connection's token, not something a projection can infer from the action. `defineAppMcp`'s `scopes:` map is refused at boot when it names a tool the server does not project (`X_MCP_SCOPE_UNKNOWN`) or claims one tool from two scopes (`X_MCP_SCOPE_CONFLICT`).

**Hide, then answer ToolNotFound — never Forbidden.** A `Forbidden` on a hidden tool is an enumeration oracle: an agent (or an attacker driving one) walks a name list and reads the org's feature set, entity names, and internal operations off the difference between "not found" and "forbidden". The visibility decision is computed from the caller, never from the arguments, so it is stable per connection and cannot be probed by varying them.

Rules:

| Rule | Detail |
|---|---|
| `visibleTo` is a role allowlist **or** a predicate over the caller | a role list admits only the roles it names, so a caller with no matching role is refused (fail-closed); a predicate takes `McpCaller` and nothing else, so it structurally cannot read call arguments and two calls with different arguments cannot reveal existence |
| `tools/list` is per-connection | computed at connect and on session change, never a static file |
| Scope gate runs **before** the policy | a scope refusal must not depend on evaluating a policy against attacker-supplied input |
| Denial reasons never leak row data | `data.reason` is a policy id, not "post p_42 belongs to org o_9" |
| Every outcome is audited | including `ToolNotFound` — an enumeration attempt is a detectable pattern, at `warn` |
| No trusted-tool mode | there is no flag that skips `evaluate` |
| Actor cannot exceed the human | the actor is the signed-in user's session; an agent inherits exactly those permissions |

## Read-only DB tool

`db.query` is defended in four layers, because "read-only by convention" is not read-only. Layers 2–4 run on every call. Layer 1 is **conditional** on the connection's own rights, so the response reports which layers engaged rather than promising four.

| Layer | What actually ships |
|---|---|
| 1. Role — conditional | a dedicated `ultimate_readonly` Postgres role: `NOLOGIN`, `USAGE` on the schema, `SELECT` on all tables, `ALL` revoked on sequences. Assumed with `SET LOCAL ROLE` **inside** the read-only transaction rather than through a second connection string — the grant reverts with the transaction, and a second pool would double the connection budget for a tool that runs one statement at a time. `NOLOGIN` means the role is unreachable by any connection string at all. Three things bound it: `ensureReadOnlyRole` returns `null` (never throws) when the connection may not `CREATE ROLE`/`GRANT` — a managed Postgres where the app user is not a role admin; `SET LOCAL ROLE` works only for a role the connected user is a member of, which is why the DDL grants that membership, so a Postgres that refuses the `GRANT` takes the whole layer with it; and `ALTER DEFAULT PRIVILEGES` reaches only objects created by the role it names, so a table created by some other role is outside the future-tables grant until the DDL is re-run. The layer is **reported as absent**, never silently assumed |
| 2. Transaction | every statement runs inside `BEGIN READ ONLY` … `ROLLBACK`, on a connection reserved out of the pool so the `BEGIN` and the statement are the same session. Postgres refuses a write even if a grant is wrong |
| 3. Parse | the leading keyword must be one of `select with explain show table values` — necessary, never sufficient. Also refused: more than one statement (a batch hides a write behind a read); any statement-level write keyword, which is what catches a data-modifying CTE (`WITH x AS (INSERT …) SELECT`), transaction control, `SET`/`COPY`, and `ANALYZE` — so `EXPLAIN ANALYZE` goes with it; a locking clause (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`); and a call from a banned function **family**, matched as a prefix of a whole token — `dblink`, `lo_`, `pg_advisory_`, `pg_try_advisory_`, `pg_cancel_backend`, `pg_ls_`, `pg_read_`, `pg_sleep`, `pg_stat_file`, `pg_stat_reset`, `pg_terminate_backend`, `set_config`. The family is the unit, never the name: an exact list admits every spelling nobody wrote down, so `pg_sleep_for` would pass a ban on `pg_sleep`, and `set_config` is `SET` — already a write keyword — spelled as a call. A `pg_advisory_*` lock is the same ban as `FOR UPDATE` and the worse breach: a session lock is not released by layer 2's `ROLLBACK`, so it outlives the read on a pooled connection (proved live in `packages/testing/src/db-integration.test.ts`). Every check runs on a form with comments, string literals, quoted identifiers and dollar-quoted bodies blanked out, so a keyword hiding in a string cannot fool it and a second statement cannot hide behind a block comment. Refused before the host ever sees the string: `X_MCP_QUERY_REJECTED`. The statement that runs is the caller's own bytes, not the stripped form |
| 4. Limits | `statement_timeout` of 5 s (`SET LOCAL`, so it cannot leak into another session), a row cap — `limit` defaults to 100 and is clamped to a hard maximum of 1000 — and a 256 KiB byte cap on the serialised rows. Truncation is flagged in the response, never silent |

The response carries a `guards` array naming the layers that actually engaged for that statement (`role:ultimate_readonly`, `txn:read-only`, `timeout:5000ms`, `parse:single-read`, `cap:100 rows` at the default `limit`, `cap:262144 bytes`), plus `truncatedBy: 'rows' | 'bytes' | null` and `bytes`. A layer that could not engage is absent from the list — `guards` is how a caller learns which defences held, instead of trusting a description.

`EXPLAIN` is available on request; `EXPLAIN ANALYZE` is refused — it executes the plan it claims to describe. `db.query` adds no tenant predicate of its own: it is a dev tool gated on `db:read`, never mounted in `ROLE=web`.

## Branch-DB-only migrations

`db.migrate` refuses anything that is not a branch database.

```bash
x db branch create feat-new-billing --json
```

```json
{"ok":true,"command":"db","data":{"branch":"feat-new-billing",
 "database":"myapp_branch_feat_new_billing",
 "preview":"http://feat-new-billing.localhost:3000","mode":"external"}}
```

**The test is the database's own name, and nothing else** (`databaseTarget`, `packages/cli/src/mcp-db-target.ts:18`). `DatabaseTarget.branch` is `branchNameOf(<database>)` — `/_branch_(.+)$/` — or, embedded, whether the data directory is `<stateDir>/pgdata-<name>` rather than `<stateDir>/pgdata`. Null means refuse.

| Check | Detail | `As of 2026-08` |
|---|---|---|
| Database name carries `_branch_` | `<source>_branch_<slug>` — the same rule `x db branch create` writes, read back from one module so `ls` and the host cannot disagree | **enforced** |
| Embedded: the data dir is a copy | `pgdata-<name>`, so the dev directory itself is never a branch | **enforced** |
| Provenance | `createBranch` stamps a `comment on database` marker and `x db branch ls` filters on it — the MCP check does **not** read it, so a hand-created `myapp_branch_x` passes on its name alone | **name only** |
| Production | `DatabaseTarget.production` is hardcoded `false`: this host is whatever `x dev` resolved, and production migrates through `ROLE=migrate` in a deploy hook, never through MCP | **not a check** |
| Destructive statements | `db.migrate` applies whatever the files hold; the rail is upstream — `x db gen` needs `--allow-destructive` to emit a drop, and `x verify`'s `drift` step refuses a committed `up` that destroys without a `-- destructive: true` line (`X_MIGRATION_DESTRUCTIVE`). The tool's own `destructive: true` is an MCP annotation, not a gate | **enforced upstream** |
| Teardown | `x db branch drop <name>` — it may only drop what `ls` shows | **shipped** |
| Build id scopes the SW | a per-branch build id, so a preview can never poison prod caches | **planned**, part of `x branch` |

An agent can migrate, seed, test, and browse a preview without risking anything shared. That is what makes "let the agent try it" a safe instruction.

## Generated facts vs. hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift fails `x verify` (`X_MANIFEST_STALE`) |
| `openapi.json` | **generated** | the HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style | under 600 lines |

### The evidence for the split

**LLM-generated context files measurably reduce task success.** A model writing "here is what this codebase does" produces confident, plausible, partly-wrong prose; the next agent treats it as ground truth, and the errors compound in a form indistinguishable from facts. Meanwhile the *verifiable* content of such a file — what routes exist, what an action takes, which policy guards it — is exactly what can be emitted from code and checked for drift.

So the split follows the verifiability line:

| Property | Generated (`x.manifest.json`) | Hand-written (`AGENTS.md`) |
|---|---|---|
| Source | code | a human's judgement |
| Checkable | yes — regenerate and diff | no |
| Failure mode if wrong | build error | a human notices |
| Volume | large, structured, machine-read | small, prose, human-read |
| Update cadence | every build | rarely |

Ultimate never generates prose documentation at runtime. `x new` scaffolds `AGENTS.md` as a terse editable stub, not an essay.

## A generated app's own MCP surface

The commercial property: **apps built with Ultimate are themselves agent-drivable**, with the user's users' sessions and the user's policies.

```ts
// apps/myapp/src/mcp.ts
export const appMcp = defineAppMcp({
  name: 'myapp',
  include: 'exposed',                                     // every mcp.expose primitive, with its policy
  scopes: { 'orders:write': ['refundOrder'], 'catalog:admin': ['reindexCatalog'] },
  resolveToken: (token) => sessions.resolveAgentToken(token),
});
```

| Property | Consequence |
|---|---|
| Actor = the signed-in user's session (or a PAT bound to that user) | an agent can never exceed the human it acts for |
| Policies unchanged | there is no separate "API permissions" screen to get wrong |
| Tool list is generated from the declaration | adding a feature adds a capability; deleting one removes it |
| `apps/admin` ships with MCP on | day-one agent access to operations, not a v3 roadmap item |
| Same three-outcome posture | hidden tools answer `ToolNotFound` in the user's app too |
| Same `--json` errors | `{ code, cause, fix, docs }` reaches the user's agent unchanged |

An action listed in `defineAppMcp` without `mcp.expose` is a build error, so exposure is always declared at the action, next to its policy — not in a distant registry file someone edits without reading the policy.

## The model call: gateway, ledger, provider seam

Every model call in an Ultimate app goes through one `Gateway`, installed once at boot by
`configureAi({ gateway })` and reached by `aiGateway(name)`. That is what makes budgets and cost
accounting un-bypassable: a stray `fetch` is the only way around it, and there is no second path.

`Gateway` is four members ([`packages/ai/src/gateway.ts`](../../packages/ai/src/gateway.ts)):
`generate`, `stream`, `scope` — which opens a `BudgetLedger` every nested call shares — and
`spent()`.

### `generate()`, in order

| Step | Detail |
|---|---|
| resolve the model | `request.model ?? defaultModel ?? DEFAULT_MODEL` |
| read the cache | `cacheKeyFor(resolved)` — model, system, messages, `maxTokens`, `effort`, `thinking`, tool **names**, stop sequences. A key that ignored `effort` or `system` would serve one prompt's answer for another |
| a hit costs nothing, so it is **not debited** | |
| `reserve(estimateSpend(resolved))` | tokens **and** money, against the worst case, **before** the provider is reached |
| `attempt(model, …)` | every provider that serves this model, each retried on a retryable failure |
| a throw releases the reservation | a call that never landed must not go on holding it |
| `record(usage, cost, reservation)` | replaces the estimate with the provider's real counts, so only the *difference* lands |
| cache the result **unless it is a refusal** | a cached refusal keeps serving a classifier decision after the prompt was fixed |

`stream()` reserves the same way and reconciles at the `done` chunk. It is **not retried
mid-flight** — the consumer has already seen tokens and replaying from the top would duplicate them
— so only the handshake retries, and a `finally` releases the reservation when `done` never arrived
because the stream threw or its consumer abandoned it.

### The provider seam

```ts
export interface Provider {
  readonly name: string;
  readonly models: readonly ModelId[];
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
}
```

Four members, and the gateway routes by `models.includes(model)`.

| Rule | Why |
|---|---|
| Fallback is across **providers serving one model**, never across models | a silent model swap changes what answered, what it cost and which eval baseline the answer belongs to |
| The provider that answered is **stamped** onto the result | `result.provider`, and `llm()` puts it on the span as `llm.provider` — the fallback that does exist is never invisible |
| Retry is exponential with **full jitter** | synchronised retries from N workers reproduce the rate limit they are backing off from. The arithmetic is `@ultimat3/core`'s `backoffDelay` since 2026-08-23 — `backoffMs` is the mapping from `RetryPolicy`'s own `baseDelayMs`/`maxDelayMs` onto it, and nothing else. Two things came with it: the delay is now **rounded** where it floored (≤ 1 ms), and a policy carrying a `NaN` waits `0` rather than handing `setTimeout` a value it fires on the next tick, i.e. a tight spin. `random` is injected, so the schedule is a list a test pins rather than a range it samples ([`20-flight-control.md`](./20-flight-control.md)) |
| `isRetryable` is core's `isRetryableStatus` — `408`, `409`, `425`, `429`, any `>= 500` — plus `ETIMEDOUT` / `ECONNRESET` | **"a 4xx is never retried" was this row until 2026-08-23 and the three that joined make it false.** Every *other* 4xx still burns the budget for nothing — the same body gets the same rejection — but 408, 409 and 425 are transient by construction. The `code` branch stays in `@ultimat3/ai` because core's table is HTTP status only |
| No provider serves the model → `X_AI_PROVIDER_UNAVAILABLE` | listing what each candidate said, or that none serves it |
| A **locally** raised coded refusal reaches the caller verbatim | `As of 2026-08-23`. `X_AI_KEY_MISSING` and `X_AI_REQUEST_INVALID` are raised before the socket opens, so the same rejection is waiting on every candidate and every attempt — collecting one into `X_AI_PROVIDER_UNAVAILABLE` discarded its runnable `fix:` and answered the same failure differently from `stream`, which never routes through the fallback loop. Only `AiTransportError`, which **is** `X_AI_PROVIDER_UNAVAILABLE`, still collects across candidates ([`packages/ai/src/gateway.ts:205`](../../packages/ai/src/gateway.ts)) |

Two hand-written providers ship — Anthropic Messages and the OpenAI chat-completions **wire format**
(Azure, vLLM, Ollama, LiteLLM, your own gateway) — and `provider-parity.test.ts` asserts both sides
of every rule inside one `test()`, so neither can move alone. Why no SDK sits behind this seam yet,
and the exact condition under which one could: [`../idea/18-build-vs-wrap.md`](../idea/18-build-vs-wrap.md).

### `BudgetLedger`: how a ceiling holds under concurrency

The subtle, load-bearing part. `BudgetLedger` ([`packages/ai/src/budget.ts`](../../packages/ai/src/budget.ts))
carries five scopes — `request`, `tokensIn`, `actor`, `org`, `costPerCall` — over an
`AsyncLocalStorage`, so a RAG retrieval, a tool call that generates and an eval judge all debit the
same ledger without threading it through every signature.

**A budget refuses; it never truncates.** A silently shortened prompt produces a confidently wrong
answer that looks real, with no signal anything happened.

Three mechanisms, each closing a hole the previous one left:

| Mechanism | The hole it closes |
|---|---|
| **`reserve()` debits, it does not merely check** | check-then-record let three concurrent calls under one ledger all read `spent() === 0`, all pass, and all three record against a ceiling only one of them fitted — an "un-bypassable" org budget bypassed by `Promise.all`. `record()` reconciles the estimate against the provider's real counts; `release()` gives it back when the call never happened |
| **`derive()` tightens and never widens** | a per-call budget declared on an `llm()` or `agent()` must not be able to widen the actor or org ceiling it runs inside. Each limit becomes the tighter of parent and child; `costPerCall` compares in one currency, and a mismatch is a config bug that throws |
| **the turnstile is the ROOT's, not the ledger's own** | `derive()` gives every call its own ledger, so a per-ledger queue serialises nothing: `Promise.all` of three derived ledgers all read the chain before any of them debits it. `reserve()` walks `parent` to the root and chains on **that** queue, so reservations under one scope take turns however deep the derivation goes |

Two more details that are not obvious from the shapes:

- **`reserveNow()` checks the whole chain, not just this ledger.** Each ledger keeps its own
  counter, and the tightest limit is not always the one with the most spent against it.
- **The turnstile chains on a settled shadow** — `gate.turnstile = turn.catch(() => undefined)` — so
  one refusal does not reject every reservation queued behind it.
- **`debit()` walks the chain for the in-memory counters and writes the STORE once**, by the ledger
  the call was made on. A child shares its parent's store and identity keys, so debiting through the
  parent as well would bill the actor and the org twice for one call.

One event loop, so a promise chain **is** the lock. A `BudgetStore` shared across *processes* needs
an atomic increment of its own; this closes the parallelism inside one. The default
`MemoryBudgetStore` is per process and resets on every deploy, which is why `org: 20_000_000` at six
replicas is six ledgers of twenty million.

## The agent loop

`agent()` ([`packages/ai/src/agent.ts`](../../packages/ai/src/agent.ts)) is a **factory over
`action()`** — the third instance of the rule after `llm()` and `backfill()`, and `hive()` is the
fourth. It exists because the alternative is a hand-rolled loop, and a hand-rolled loop is where the
dangerous mistake lives: taking the **actor** from the model's output.

```ts
agent({
  input, output, prompt, vars,
  tools: [lookupOrder, issueRefund],   // real action()s, each mcp: { expose: true }
  maxTurns: 6,
  budget: { tokensPerRun: 200_000, costPerCall: { minor: 50, currency: 'USD' } },
  policy: can('order:support'),
  onTurn: (event) => progress.push(event),
})
```

| Decision | Detail |
|---|---|
| `tools` accepts `AnyAction \| ProjectableAction` | the app's own `action()` first, because that is what an app has. Until 2026-08 the list took `ProjectableAction` alone — which no `action()` structurally satisfies — so the documented shape was a `TS2741` and every test in the package hand-built a stand-in |
| Exposure is checked at **declaration** | `isMcpExposed(tool.mcp)` over the *declaration*, not the projection: a real `action()` beside it in the same module has no name until `registerAction` runs at boot. `X_AGENT_TOOL_UNEXPOSED` |
| Projection is **memoised on first run** | for the same reason: naming a tool at module scope would make the ordinary `export const publishPost = action(...)` beside it `X_ACTION_UNREGISTERED` |
| The actor is read **once**, from `ctx` | nothing below reads an actor out of a model result. A loop that let the model name its identity would be an escalation primitive |
| `throwIfAborted(ctx)` at the top of every turn **and** before every tool batch, plus `signal` on the request | the transcript **is** the request, so a loop that keeps going after a disconnect re-sends it once per remaining turn, runs every remaining side effect and discards the answer. The signal rides on `GenerateRequest` too, so a provider call already in flight is cut rather than paid for |
| Tools of one turn run through one `Promise.all`, **unbounded** | the batch is what a single model turn asked for, each entry is an action with its own `policy` and `rateLimit`, and a second ceiling here would be a throttle competing with those. Results pair **positionally**, each carrying the `tool_use` id it was handed |
| The ledger is `(currentBudget() ?? new BudgetLedger({ limits: {} })).derive(limitsOf(def))` | `tokensPerRun` maps onto the ledger's `request` scope, which accumulates across every call made under one `withBudget` — which for a run is exactly "the whole run" |
| Structured output is the forced `respond` tool | `respondToolFor(def.output)`, offered beside the app's tools and filtered out of `toolCalls` before `onTurn` sees them |
| A bad shape gets **another turn**, not one repair | unlike `llm()`, this loop has turns left by construction, and the correction is the message rather than a tool result |
| Two exhaustions, two codes | `X_LLM_OUTPUT_INVALID` when every attempt was the wrong shape; `X_AGENT_MAX_TURNS` when the loop kept calling tools and never answered |
| `onTurn` is **awaited and unguarded** | a throw fails the run. It is the app's code on the run's own path, and an observer that quietly stopped working reads exactly like one that is fine. The same facts always land on the span as an `agent.turn` event |
| **No semantic cache**, deliberately | similar prompts do not have similar answers once the answer depends on what `lookupOrder` returned this second, and a cache over that would serve one run's world state to another |
| **No `.stream()`** | `agent()` returns a plain `Action`; only `llm()` returns `LlmAction`. A tool call arrives whole, so per-turn is the finest granularity a tool loop has |

`hive()` fans one action out over many inputs through a bounded, order-preserving,
cancellation-linked pool (`hive-pool.ts`), reporting three member arms — `ok`, `failed`, `skipped`
— because *ran and threw* and *never ran* are different facts. `agentJob()` (tier 4, which is why
the adapter lives in `@ultimat3/ai` and not in `action` or `jobs`, both tier 3) composes a real
`job()` around the action projection, so `.enqueue()`, the outbox, the worker's cancellation and the
dead-letter path all arrive without a line of its own. Reference: [`wiki/Agents.md`](../../wiki/Agents.md).

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_MCP_SCOPE_DENIED` | connection scope lacks this tool | reconnect with the named scope |
| `X_MCP_SCOPE_UNKNOWN` | `defineAppMcp`'s `scopes:` names a tool this server does not project | spell the projected tool name, or drop the entry from `scopes` |
| `X_MCP_SCOPE_CONFLICT` | two scopes in `defineAppMcp`'s `scopes:` claim one tool | keep the tool under a single scope |
| `X_MCP_QUERY_REJECTED` | `db.query` got something other than one read-only statement | send exactly one read-only `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` aimed at a non-branch database | `x db branch create <name>   # then retry db.migrate` |
| `X_MCP_TOOL_UNDECLARED` | `defineAppMcp` lists an action without `mcp.expose` | add `mcp: { expose: true, description }` |
| `X_MANIFEST_STALE` | manifest/openapi differ from the code | `x manifest` |
