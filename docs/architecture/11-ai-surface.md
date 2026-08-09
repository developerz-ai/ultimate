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
| tool name | action name, kebab-cased | `publish-post` |
| input JSON Schema | the ArkType `input` via Standard Schema → JSON Schema | the same schema HTTP parses |
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
| Tool invoked, but the **policy denies this input** | `X_POLICY_DENIED` with the denial reason | identical to the HTTP answer for the same call |

**Hide, then answer ToolNotFound — never Forbidden.** A `Forbidden` on a hidden tool is an enumeration oracle: an agent (or an attacker driving one) walks a name list and reads the org's feature set, entity names, and internal operations off the difference between "not found" and "forbidden". The visibility decision is computed from role, not from input, so it is stable per connection and cannot be probed by varying arguments.

Rules:

| Rule | Detail |
|---|---|
| Visibility is role-derived, input-independent | so two calls with different arguments cannot reveal existence |
| `tools/list` is per-connection | computed at connect and on session change, never a static file |
| Scope gate runs **before** the policy | a scope refusal must not depend on evaluating a policy against attacker-supplied input |
| Denial reasons never leak row data | `data.reason` is a policy id, not "post p_42 belongs to org o_9" |
| Every outcome is audited | including `ToolNotFound` — an enumeration attempt is a detectable pattern, at `warn` |
| No trusted-tool mode | there is no flag that skips `evaluate` |
| Actor cannot exceed the human | the actor is the signed-in user's session; an agent inherits exactly those permissions |

## Read-only DB tool

`db.query` is defended four ways, because "read-only by convention" is not read-only.

| Layer | Mechanism |
|---|---|
| 1. Connection | a dedicated Postgres role with `SELECT`-only grants and no `USAGE` on sequences; separate connection string |
| 2. Transaction | every statement runs in `BEGIN READ ONLY` — Postgres refuses writes even if a grant is wrong |
| 3. Parse | a single statement only; multiple statements, `COPY`, `DO`, and any DDL are refused before reaching the server (`X_MCP_QUERY_REJECTED`) |
| 4. Limits | `statement_timeout`, a row cap (default 1000, truncation flagged in the response), and a byte cap |

`EXPLAIN` / `EXPLAIN ANALYZE` are available on request — `ANALYZE` still inside `READ ONLY`, so a plan can be measured without a write path. Results carry the tenant filter the caller's session implies; a query without a tenant predicate against a tenant-scoped table is rejected with a fix that adds it.

## Branch-DB-only migrations

`db.migrate` refuses anything that is not a branch database.

```
x branch feat-new-billing
  ✓ database    myapp_feat_new_billing   (copy-on-write from dev template, 340ms)
  ✓ build       build id 8f2a1c…
  ✓ preview     http://feat-new-billing.localhost:3000
  ✓ mcp         ws://localhost:9229/feat-new-billing
```

| Check | Detail |
|---|---|
| Database name matches the branch pattern | `<app>_<branch-slug>` |
| The branch registry lists it as a branch, created by `x branch` | a hand-created database named like a branch is still refused |
| The connection is not the shared dev or any production-tagged URL | refusal is `X_MCP_NOT_BRANCH_DB`, `fix: x branch <name>` |
| Destructive statements | require `--allow-destructive` even in a branch |
| Teardown | `x branch rm <name>`; the SW cache namespace is build-ID-scoped, so a preview can never poison prod caches |

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
// packages/mcp/src/index.ts
export const appMcp = defineAppMcp({
  name: 'myapp',
  actions: [publishPost, refundOrder, reindexCatalog],   // must declare mcp.expose
  queries: [orderById, revenueByDay],
  scopes: { 'orders:write': [refundOrder], 'catalog:admin': [reindexCatalog] },
  auth: 'session',                                        // 'session' | 'pat'
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
| `X_MCP_QUERY_REJECTED` | `db.query` got a non-single-SELECT statement | send one read-only statement |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` aimed at a non-branch database | `x branch <name>` |
| `X_MCP_TOOL_UNDECLARED` | `defineAppMcp` lists an action without `mcp.expose` | add `mcp: { expose: true, description }` |
| `X_MANIFEST_STALE` | manifest/openapi differ from the code | `x manifest write` |
