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

| Tool | Handler | Reads | Write scope |
|---|---|---|---|
| `routes.list` | `manifest` | route table: path, render, hydrate, offline, budget, meta status | read |
| `schema.describe` | `entity` | tables, columns, types, indexes, FKs, invariants | read |
| `policies.list` | `policy` | every policy, its consumers, its denial reason | read |
| `actions.list` | `action` | inputs, outputs, tags, MCP exposure | read |
| `manifest.get` | `manifest` | the whole `x.manifest.json` | read |
| `tests.run` | `testing` | run a type or a single file, structured results | branch env only |
| `logs.tail` | `core` | structured logs + OTel spans, filterable | read |
| `db.query` | `entity` | **read-only** SQL, row cap, `EXPLAIN` on request | read-only connection |
| `db.migrate` | `entity` | generate + apply migrations | **branch DB only** |
| `errors.explain` | `core` | `X_*` → title, cause template, fix, docs | read |
| `budgets.report` | `render` | per-route bytes/LCP + the import chain behind a regression | read |
| `live.explain` | `realtime` | a live query's matcher class and estimated cost | read |
| `jobs.list` / `jobs.status` / `jobs.retry` | `jobs` | queue state, step timeline | same authz as the actions |

Read tools are unrestricted in dev. Write tools are scoped to branch environments.

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
