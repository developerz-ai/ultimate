# @ultimat3/mcp — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `render manifest ai pwa ui admin testing cli`.

Same-tier data (routes, manifest, policy catalog) arrives as an **injected thunk**, never an
import. The CLI wires it.

## Owns

| File | Job |
|---|---|
| `wire.ts` | JSON-RPC types, error codes, protocol version, `JsonSchema` subset |
| `registry.ts` | catalog + the first two security outcomes (visibility, scope) |
| `audit.ts` | one structured line per `tools/call`, outcome → level |
| `validate-args.ts` | JSON-Schema-subset arg validation, applies defaults |
| `server.ts` | JSON-RPC dispatch, `classify` for rate-limit buckets |
| `from-action.ts` | action/query → tool; the "one authz system" projection; `toolsFrom` (sweep, skips) vs `toolsListed` (written out, refuses) |
| `resources.ts` | resources + prompts, stable `ultimate://` URIs |
| `dev-server.ts` | the 13 dev tools; depends only on an injected `DevHost` |
| `dev-host.ts` | wires `describe*` from entity/action/query/jobs into a `DevHost` |
| `transport-http.ts` | `POST /mcp` route descriptor, bearer → agent actor |
| `transport-stdio.ts` | NDJSON on stdin/stdout for `x mcp serve` |
| `app-tools.ts` | `defineAppMcp` — a generated app's own MCP surface, one call |
| `app-tool.ts` | the authored `tools: { name: {...} }` record → `ProjectablePrimitive` |
| `projectable.ts` | a real `action`/`query` → `ProjectablePrimitive`; the ONE adapter both the sweep and the written-out list use |
| `exposed.ts` | `include: 'exposed'` — the action/query registries → primitives |
| `scopes.ts` | the `scopes:` map — outcome 2's declaration surface; boot-time refusal of an unknown or doubly-claimed tool |
| `input-schema.ts` | Standard Schema → the `JsonSchema` subset `validate-args.ts` enforces |
| `readonly-sql.ts` | layer 3 of `db.query` — the single-read parse — and `db.migrate`'s branch check |
| `query-limits.ts` | layer 4 of `db.query` — the row, byte and timeout ceilings, and what truncation reports |

## Invariants

- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so a `defineAppMcp` file
  imports one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on
  every access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- Three outcomes, never blurred: role-hidden → `-32601` ToolNotFound with no `data`;
  scope → `-32600` `X_MCP_SCOPE_DENIED` naming the scope; policy → an `isError` result
  carrying `X_FORBIDDEN`. Swapping any two is an enumeration oracle.
- `visibleTo` is **fail-closed** three ways: a role list admits only the roles it names (a
  caller with no role matches none), a predicate must return the literal `true`, and a
  predicate that THROWS hides the tool. A predicate takes the caller — never the arguments —
  so existence cannot be probed by varying input. `tools/list` is answered per caller: one
  `McpCaller` per HTTP request, one per stdio connection.
- `visibleTo` declared in a primitive's `mcp` block is carried through `exposed.ts`'s
  `exposureOf` to the projected tool — outcome 1's only declaration surface for a projected
  primitive. Dropping it there silently disables outcome 1 for every projected tool: nothing
  fails, every caller simply sees every tool.
- Resolve order is visibility → scope → args → policy. Validating first leaks a schema;
  running the policy first decides a refusal from attacker-supplied input.
- A framework error rendered into a tool result is **byte-identical to
  `UltimateError.format()`** — one denial must not read one way over MCP and another in the
  terminal. `server.ts` renders it; the test pins it against `format()`, never a literal.
- Every outcome is audited via `audit.ts`, hidden included, at `warn`. Never log arguments
  or row data — a denial reason naming a row is a leak wearing an audit line's clothes.
- `security.test.ts` and `app-security.test.ts` are the executable contract for all of the
  above — the first over hand-built tools (each gate in isolation), the second over what an app
  actually declares (`defineAppMcp` projecting real actions and queries). Extend them, never
  weaken them. A gate can only refuse what a declaration can reach, so a new gate needs a test
  in BOTH: the registry half passes while the declaration surface silently drops the field.
- **`isExposed` and `exposureOf` both delegate to `isMcpExposed` in `@ultimat3/core`.** That is the
  framework's one answer to "did this opt in?", shared with `action`, `query`, `ai` and `manifest`
  — five packages that cannot import each other, which is how three spellings of the check shipped
  and why the pin lives in `@ultimat3/cli`. Never spell `=== true` inline here again.
- Exposure is declared at the primitive, never in `defineAppMcp`. A primitive NAMED in
  `actions:`/`queries:` without `mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot —
  a written-out list is a request, so filtering it would ship a catalog missing a tool its
  author believes is there. `include: 'exposed'` sweeps the registries and therefore skips,
  because that list is every primitive the app registered, not one anyone wrote out.
  `actions:` and `queries:` go through **one** `toolsListed` call over the concatenation: it
  collects every offender before throwing, so one boot names all of them and one edit closes
  all of them. Two calls would throw on the first array and never examine the second.
- `actions:`/`queries:` take the **real primitives** (`actions: [publishPost]`), adapted by
  `projectable.ts` into the same `ProjectablePrimitive` the registry sweep builds. They took
  `ProjectablePrimitive` alone until 2026-08, which no `action()` or `query()` satisfies — they
  carry `as`/`tool`, never `run` — so listing one was a TS2741 and the only value that could
  reach `X_MCP_TOOL_UNDECLARED` was a hand-built fake. A gate that no declaration can reach
  refuses nothing. `ProjectablePrimitive` stays in the union for surfaces that build a catalog
  programmatically (`@ultimat3/admin`); `isAction`/`isQuery` read each package's private
  declaration store, so a look-alike falls through instead of borrowing `invoke`.
- The adapter is **one function with two callers**, never a copy per route: the written-out list
  and `include: 'exposed'` land on the same `run` — `invoke` for an action, `sourceFor` for a
  query. Writing a primitive out NAMES a tool; it never re-shapes or re-runs one. An action
  with no export name is `X_ACTION_UNREGISTERED` rather than a tool called `''`, which no
  `tools/call` and no `scopes:` entry could ever address.
- Every boot-time refusal in `defineAppMcp` is an `UltimateError` with a code, never a bare
  throw: `X_MCP_TOOL_UNDECLARED`, `X_MCP_TOOL_UNSAFE`, `X_MCP_TOOL_DUPLICATE`,
  `X_MCP_SCOPE_UNKNOWN`, `X_MCP_SCOPE_CONFLICT`. The caller reading them is usually an agent
  that needs `{ code, cause, fix }`.
- `scopes:` is refused at boot two ways, both because the alternative ships a tool silently
  ungated: a name no projected tool answers to is `X_MCP_SCOPE_UNKNOWN` (a typo, a rename, a
  primitive never listed); one tool claimed by two scopes is `X_MCP_SCOPE_CONFLICT` — a tool
  carries exactly one, and object key order is not a security model.
- The **projection** invents no `scope` — `toolFromAction` cannot know what a token means.
  `defineAppMcp`'s `scopes:` may attach one afterward, as a capability of the CONNECTION; that
  is not a second authz path, because the scope gate decides before the policy runs and never
  reads the input. A hand-written app tool is the same: its `policy` reaches `guard()` from
  `@ultimat3/action`, which is the one authz path that reads the input — never a second check
  written for MCP.
- `db.query` / `db.migrate` refuse structurally, in `readonly-sql.ts`, before the host runs
  (`X_MCP_QUERY_REJECTED` / `X_MCP_NOT_BRANCH_DB` — one code each, because they want different
  next commands).
- Banned SQL functions are matched as a **prefix of a CALLED function name**, so the family is the
  unit and a spelling nobody wrote down is refused rather than admitted — an exact-name list let
  `pg_sleep_for` past a ban on `pg_sleep`, and `set_config` past `SET`, which is already a write
  keyword. Add a family, never a name. The unit is the call (`name` before `(`), never a bare word:
  a word scan refused a column named `pg_sleep_for_seconds`. The call scan reads a strip that KEEPS
  quoted-identifier content, because `"pg_advisory_lock"(1)` is the same call as the bare spelling —
  the keyword scan still reads the blanked form, so `select "update" from t` stays a column. Two of the families exist because the same ban is already
  made elsewhere in another spelling: `pg_advisory_*` is `FOR UPDATE`'s ban and the worse breach
  (a session lock survives layer 2's `ROLLBACK`, so it outlives the read on a pooled connection —
  proved live in `packages/testing/src/db-integration.test.ts`), and `pg_sleep*` is the one ban
  that still holds on embedded PGlite, whose single WASM thread cannot honour a statement timeout.
- `db.query` is defended four ways: a SELECT-only role and `BEGIN READ ONLY` in `@ultimat3/db`
  (the CLI wires them — this package must never import `db`), the parse here, and the caps here.
  `limit` is a request, never a permission: `resolveQueryLimits` clamps it into a hard 1000.
- The caps run in the **tool**, not the host. A host that forgets them answers a million rows
  into a model's context. `guards` names the layers that engaged; a layer that could not engage
  is absent from the list, never assumed present.
- `transport-stdio.ts` never writes stdout except the wire. Diagnostics → stderr.
- New mutating tool ⇒ set `destructive: true`, or it is metered as cheap read chatter.

## Commands

```
bun test packages/mcp
bun run --filter @ultimat3/mcp typecheck
```
