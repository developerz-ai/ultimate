# @ultimat3/mcp — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http auth
action query jobs realtime`. **Never** `render manifest ai pwa ui admin testing cli`.

`@ultimat3/http` is a DIRECT dependency (`transport-http.ts`, the rate limiter). So is
`@ultimat3/auth` (`oauth-server.ts`): the authorization server is auth's; this package binds it.

Same-tier data (routes, manifest, policy catalog) arrives as an **injected thunk**, never an
import. The CLI wires it.

## Owns

| File | Job |
|---|---|
| `wire.ts` | JSON-RPC types, error codes (incl. `-32020`/`-32022`), `MCP_MODERN_VERSIONS` / `MCP_LEGACY_VERSIONS` (no `MCP_PROTOCOL_VERSION`: name the era), `JsonSchema` subset |
| `registry.ts` | catalog + the first two security outcomes (visibility, scope) |
| `audit.ts` | one structured line per `tools/call` and per `resources/read`, outcome → level |
| `validate-args.ts` | JSON-Schema-subset arg validation, applies defaults |
| `server.ts` | JSON-RPC dispatch; `classify` delegates to `protocol-era.ts` |
| `protocol-era.ts` | one request's era (`_meta` version), `METHODS` per era, `classifyBody`, `initialize` negotiation, `server/discover`, the modern stamp, the HTTP mirrored-header check and each answer's status |
| `server-resources.ts` | `resources/read`'s three outcomes, audited, provider in a `try` |
| `from-action.ts` | action/query → tool; the "one authz system" projection; `toolsFrom` (sweep, skips) vs `toolsListed` (written out, refuses) |
| `resources.ts` | resources + prompts, stable `ultimate://` URIs |
| `dev-server.ts` · `dev-ui-*.ts` · `dev-graph-tool.ts` | the 19 dev tools: 13 here (`routes.list` … `logs.tail`), the five `ui.*`, `graph.query`. Depends only on an injected `DevHost` |
| `dev-host.ts` | wires `describe*` from entity/action/query/jobs into a `DevHost` |
| `transport-http.ts` | `POST /mcp` route descriptor, bearer → agent actor, and the per-caller rate limit it enforces itself; it keeps the order |
| `transport-http-answers.ts` | the pre-dispatch answers (401, 403 not-an-agent / origin, 421, 429) and the per-address failure meter |
| `audit-hook.ts` | `onAudit`; `resolveToken`'s 2nd arg is http's `RequestFacts` (`seen.address` only, never `x-forwarded-for`), re-exported as `McpRequestFacts` |
| `confirmations.ts` · `confirmation-*.ts` | `mcpConfirmations`: a factory over `action` (view/decide) · the gate on `handle` · stores · DDL · codes. `confirmation-installed.ts` is the `mcpConfirmationStore` slot a declaration with no `store` reads; `adapter.ts` (`./adapter`) its interface, error and installer |
| `oauth-metadata.ts` | RFC 9728 protected-resource metadata + the 401 `resource_metadata` challenge (`defineAppMcp({ oauth })`) |
| `oauth-server.ts` | `mcpAuthorizationServer`: `@ultimat3/auth`'s `authorizationServer` bound to one endpoint's `resource` (default and required by `resolveToken`), its `oauth` block, `mcp.auth.<event>` lines. No protocol rule lives here |
| `transport-stdio.ts` | NDJSON on stdin/stdout for `x mcp serve` |
| `app-tools.ts` | `defineAppMcp` — a generated app's own MCP surface, one call |
| `runtime-*` · `*-catalog.ts` · `tenant.ts` | `catalog:` (`runtimeTool()`, checked, merged per request) · `tenant:` (`list_tenants`); codes in `catalog-errors.ts` |
| `app-tool.ts` | the authored `tools: { name: {...} }` record → `ProjectablePrimitive` |
| `projectable.ts` | a real `action`/`query` → `ProjectablePrimitive`; the ONE adapter both the sweep and the written-out list use |
| `exposed.ts` | `include: 'exposed'` — the action/query registries → primitives |
| `include-early.ts` | `assertIncludeCurrent`, the mount's after-scan check (`X_MCP_INCLUDE_EARLY`) — [history](../../docs/history/mcp.md) |
| `scopes.ts` | the `scopes:` map — outcome 2's declaration surface and its three boot refusals |
| `readonly-sql.ts` · `readonly-sql-calls.ts` | layer 3 of `db.query` — the single-read parse — and `db.migrate`'s branch check · the banned call families |
| `query-limits.ts` | layer 4 of `db.query` — the row, byte and timeout ceilings, and what truncation reports |
| `meta-surface.ts` · `meta-catalog-render.ts` | `surface: 'meta'` catalog, `groups:` boot checks (dispatch: `server.ts`) · its text, `catalogDetail` |
| `meta-split.ts` · `meta-split-call.ts` · `meta-host.ts` | `surface: 'meta-split'`: the three dispatchers, the effect boot check · their dispatch (wrong tool, preview, `confirmed_by_user`) · the server half both meta doors call |
| `list-params.ts` | `listParams` whitelist → the schema `manage_resource` enforces (flat keys: `status_eq`) |
| `meta-errors.ts` · `framework-error.ts` | meta boot refusals · a thrown value read and rendered (split from `server.ts`) |
| `server-voice.ts` · `surface-budget.ts` | `instructions`, `errorAudience`, the invalid-args RESULT · `tools/list`/`list_resources` size, measured and budgeted |
| `job-*` · `recipe*` · `remote-*` | `jobTool`/`job_status` · `recipes:`/`docs` · `mcpTools`/`mcpClient`/`tools.lock.json` — [history](../../docs/history/mcp.md) |

## Invariants

- **Dual-era, per request** (`As of 2026-11`, MCP 2026-07-28). A `_meta` version in
  `MCP_MODERN_VERSIONS` → modern: stateless, `server/discover`, no `initialize`/`ping`, every result
  stamped (`resultType`, `_meta` `serverInfo`; lists/reads `ttlMs: 0`, `cacheScope: 'private'`).
  None, or one in `MCP_LEGACY_VERSIONS` → legacy. Else `-32022`. Resource not found is one answer
  per era (`-32602` modern, `-32601` legacy, never `data`). A modern HTTP request's mirrored
  headers equal its body (`headerRefusal`): absent or unequal → 400 `-32020`.
- **`Origin` is core's `proveSameOrigin`, at the transport, before the token is read** (403
  `X_MCP_ORIGIN_REFUSED`, audited `origin-refused`): self = `seen.origin`, allowance = `seen.listed`
  (`http.cors.origins`), never a second origin rule. It cannot refuse a DNS-rebound name: `x mcp
  serve` refuses a non-loopback Host first (421 `X_MCP_HOST_REFUSED`). `GET`/`DELETE` is
  `@ultimat3/http`'s one `X_METHOD_NOT_ALLOWED` 405, mount and `x mcp serve` alike.

- **`manage_resource` is a second DOOR, never a second PATH** (`As of 2026-09-26`): locate (visibility,
  else the absent answer) → the shared `resolve` (scope → args; a list whitelist's issues win) → `dispatch`,
  audited under the inner tool. `tools/list` shows what `tools/call` answers PER CALLER: a meta caller
  cannot call a grouped tool by name, a flat caller never sees the meta tools, and every not-found a
  meta caller gets carries `META_UNKNOWN_FIX`. Default `'flat'` builds no `MetaSurface`.
  **`'meta-split'` is three more doors on the same path** (`As of 2026-10-18`): the effect picks the
  door and is never defaulted (`X_MCP_EFFECT_UNDECLARED` at boot); a wrong door runs nothing
  (`X_MCP_WRONG_TOOL`, after visibility, before scope); `delete_resource` previews unless `live:
  true` and commits only on `confirmed_by_user: true`, both after the policy's actor half.

- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so a `defineAppMcp` file
  imports one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on
  every access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- **Every refusal carries its instruction** (`As of 2026-09-07`). The 413 and the batch refusal
  were bare `-32600`s; both now carry `data: { code, fix }` built by the error class that owns the
  wording (`McpBodyTooLargeError`, shared with the stdio line cap; `McpProtocolError`). The
  `-32601` for a tool carries no `data` — see the next rule — so its instruction rides in the
  MESSAGE, and it is `TOOL_UNKNOWN_FIX`, the same sentence on the absent and the hidden branch.
- **`ping` answers `{}` and `prompts/get` resolves, `As of 2026-09-23`.** Both answered `-32601`
  while `initialize` advertised `prompts` and `prompts/list` listed them. A prompt's body is an
  injected `read(args)` (`promptFromPath` reads its file on each call); a prompt with none, an
  unknown name or a missing name is `-32602`. `prompts/list` sends `promptListEntry` — never the
  object, whose reader is a function. `METHODS` and `classify` move with every new method.
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
- **A thrown value is a framework error only when its `code` matches core's `FRAMEWORK_CODE`**,
  never `code.startsWith('X_')` (`asFrameworkError` puts the code in a command). Full rule: `docs/history/mcp.md`.
- **`catalog(caller)` runs per `tools/list`/`tools/call`**, never cached; a duplicate or a throw fails
  the REQUEST (`X_MCP_CATALOG_*`), never a smaller list. **`tenant` runs first on a call**: `null` =
  the hidden-tool answer, a throw `X_MCP_TENANT_UNRESOLVED`; its actor is the caller from there on.
- Resolve order is visibility → scope → args → policy. Validating first leaks a schema;
  running the policy first decides a refusal from attacker-supplied input.
- **A key's membership of a declared schema is `Object.hasOwn(properties, key)`**, never an index
  read (`Object.prototype` answers four names); a validated key lands through `Object.defineProperty`.
  Full rule: `docs/history/mcp.md`.
- **The RESOURCE surface owes the same three outcomes as the tool surface.** `resources/list` and
  `resources/read` take the `McpCaller`; `McpResource` carries `visibleTo` and `scope`, applied by
  `ResourceRegistry.resolve` in `ToolRegistry.resolve`'s order through the same `visibleToCaller`.
  The not-found branch carries no `data` (a catalog there enumerates it). `resource-security.test.ts`
  is the contract, for hand-built resources AND `defineAppMcp({ resources })`.
- **Every provider call is inside a `try`** (an injected `read` thunk can throw ENOENT): a framework
  error keeps its code/cause/fix, anything else is `-32603`. Full rule: `docs/history/mcp.md`.
- **A declared `pattern` is compiled once per schema NODE, never per `tools/call`** — a `WeakMap`
  keyed on the node (never on the pattern string, which grows forever), caching an uncompilable
  pattern's `null` too. `compiledPatternCount()` is the test-only probe; `validate-args.test.ts`
  asserts it does not climb over 100 calls. Compiled WITH `x-ultimate-pattern-flags` (schema's),
  `lastIndex` reset.
- **`format` is NOT in the wire subset** (`wire.ts` types it `never`): its meaning is
  `@ultimat3/schema`'s; `pattern` is kept. `validate-args-subset.test.ts` asserts every published
  keyword is enforced. Full rule: `docs/history/mcp.md`.
- **A hand-written app tool parses its own input**, in the slot `invoke` puts it: parse, then
  `guardAction()`, then `handle`. A projected action re-parses inside `invoke`; `app-tool.ts` had no second
  parse, so `handle` was handed whatever the wire subset let through — typed `InferOutput<TInput>`,
  past the policy. One code either way, `X_INPUT_INVALID`, built from `@ultimat3/action`'s own
  `InputInvalidError`.
- **Anything a tool RETURNS is rendered totally** (`jsonResult`: nothing, a bigint, a cycle, a
  throwing `toJSON`) — unreadable is an `isError` result, never an escape past `server.ts`'s catch;
  `query-limits.ts`' `rowBytes` prices a bigint row `Infinity` rather than raising in the cap.
- **A thrown value is read with `stringField` from `@ultimat3/core`, never `typeof e.code ===
  'string'`**: each read is a getter or `Proxy` trap in the catch that owes an answer, and a probe
  that raises there leaves the request with none, not even `-32603`.
- A framework error rendered into a tool result is **byte-identical to
  `UltimateError.format()`** — one denial must not read one way over MCP and another in the
  terminal. `server.ts` renders it; the test pins it against `format()`, never a literal. Except a
  hidden 5xx for `'caller'` (`forAudience`, `As of 2026-10`): `statusFor(code) >= 500` and not core's
  `hasPublicCause` → `HIDDEN_CAUSE` + `x errors explain`, tool results and resource reads alike.
- Every outcome is audited via `audit.ts`, hidden included, at `warn`. Never log arguments or row
  data. **On both surfaces**: `mcp.tool-call.<outcome>` and `mcp.resource-read.<outcome>` — two
  events, one `LEVEL` table, so an alert can tell a URI walk from a tool-name walk. `resources/list`
  and `tools/list` are silent by design (answered pre-filtered). `resource-security.test.ts` reads
  both streams: core's logger puts `error` on stderr.
- **A tool that renders its OWN `isError` result may NAME the code it refused with**
  (`McpToolResult.code`, audit-only, never on the wire); `outcomeForResult` sends it through the
  `outcomeForCode` a thrown error takes. Unnamed keeps the conservative `policy-denied`. Why:
  `X_ADMIN_INVALID` (`ARGUMENT_CODES`) sat in the enumeration alert's bucket. `X_INPUT_INVALID`
  stays `failed` — a projected action's whole schema was already validated, so it means drift.
  `X_MCP_CONFIRMATION_PENDING`/`_EXPIRED` are `unconfirmed` (`info`); `_REJECTED` is a denial.
- **`onAudit` is a second DESTINATION, never a second path** (`audit-hook.ts`, `As of 2026-10`):
  the line is written, then the decision handed on, unawaited; a throwing hook changes no answer
  (`mcp.audit-hook.failed`). Core's `AuditSink` = what a primitive DID; `onAudit` = what the gate
  decided, refused tokens included (`mcp.auth.<reason>`). The route reads `server.audit`.
- **A `--` comment ends at the first CR *or* LF** (`readonly-sql.ts`): why in `docs/history/mcp.md`.
- `security.test.ts` and `app-security.test.ts` are the executable contract for all of the
  above — the first over hand-built tools (each gate in isolation), the second over what an app
  actually declares (`defineAppMcp` projecting real actions and queries). Extend them, never
  weaken them. A gate can only refuse what a declaration can reach, so a new gate needs a test
  in BOTH: the registry half passes while the declaration surface silently drops the field.
- **Exposure is core's `isMcpExposed`** (private `exposed` and `exposureOf`; no exported
  wrapper since 25.0.0) — the one answer shared with `action`, `query`, `ai`, `manifest`; the pin
  lives in `@ultimat3/cli`. Never spell `=== true` inline here again.
- Exposure is declared at the primitive, never in `defineAppMcp`. A primitive NAMED in
  `actions:`/`queries:` without `mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot;
  `include: 'exposed'` sweeps the registries and skips. Both lists go through **one**
  `toolsListed` call, so one boot names every offender. Why: `docs/history/mcp.md`.
- `actions:`/`queries:` take the **real primitives** (`actions: [publishPost]`), adapted by
  `projectable.ts` into the same `ProjectablePrimitive` the sweep builds. `ProjectablePrimitive`
  stays in the union for programmatic catalogs (`@ultimat3/admin`); `isAction`/`isQuery` read each
  package's private store, so a look-alike falls through.
- The adapter is **one function with two callers**, never a copy per route: the written-out list
  and `include: 'exposed'` land on the same `run` — `invoke` for an action, `sourceFor` for a
  query. Writing a primitive out NAMES a tool; it never re-shapes or re-runs one. An action
  with no export name is `X_ACTION_UNREGISTERED` rather than a tool called `''`, which no
  `tools/call` and no `scopes:` entry could ever address.
- **This package NAMES a tool, never derives one**: `primitive.name`, verbatim from
  `projectable.ts`; core's `McpExposureDeclaration` is the one block, no `name` (`type-pins.ts`). `x-ultimate.mcpTool` and
  `ActionDescriptor.mcp.tool` owe the same string (`cross-surface.test.ts`).
- **`toolFrom` is THE tool projection** (O-tool, 25.0.0), over a real action/query or a
  `ProjectablePrimitive`; `toolListEntry(toolFrom(x))` deep-equals the `tools/list` entry.
  action/query `.tool()` and the `toolFromQuery` alias are deleted.
- Every boot-time refusal in `defineAppMcp` is an `UltimateError` with a code, never a bare
  throw: `X_MCP_TOOL_UNDECLARED`, `X_MCP_TOOL_UNSAFE`, `X_MCP_TOOL_DUPLICATE`,
  `X_MCP_SCOPE_UNKNOWN`, `X_MCP_SCOPE_CONFLICT`, `X_MCP_SCOPE_UNCOVERED`. The caller reading them is usually an agent
  that needs `{ code, cause, fix }`.
- `scopes:` is refused at boot three ways, each shipping a silently ungated tool otherwise: a name
  nothing projects (`X_MCP_SCOPE_UNKNOWN`); one tool under two scopes (`X_MCP_SCOPE_CONFLICT` —
  key order is not a security model); a tool under none (`X_MCP_SCOPE_UNCOVERED`, `As of 2026-10`:
  it answered every token while `bearerMount` served it to nobody — `scope-surfaces.test.ts`).
- The **projection** invents no `scope` — `toolFrom` cannot know what a token means.
  `defineAppMcp`'s `scopes:` may attach one afterward, as a capability of the CONNECTION; that
  is not a second authz path, because the scope gate decides before the policy runs and never
  reads the input. A hand-written app tool is the same: its `policy` reaches `guardAction()` from
  `@ultimat3/action`, which is the one authz path that reads the input — never a second check
  written for MCP.
- **A URI is taken once.** `ResourceRegistry.register` throws `X_MCP_RESOURCE_DUPLICATE` on a
  second claim, exactly as `ToolRegistry.register` throws on a second tool name — one package
  cannot answer "this name is taken" two ways. `Map.set` made the answer whichever provider was
  wired last, and a `ultimate://` URI is quoted in AGENTS.md files.
- **`\'` inside a string literal is refused** (`readonly-sql.ts`) — why: `docs/history/mcp.md`.
- **An unterminated run is refused, never swallowed** (`readonly-sql.ts`, all four delimiters, `X_MCP_QUERY_REJECTED`) — why: `docs/history/mcp.md`.
- **`into` is a write keyword.** `SELECT ... INTO <table>` is `CREATE TABLE AS` in another spelling:
  a DDL write with a read LEADER, so nothing else in the scan sees it. Layer 2's `BEGIN READ ONLY`
  refuses it on the wired path — the point is that this layer must not be the thing that waves it
  through, and `@ultimat3/admin`'s `/_x` panel is a second caller whose layer 2 is its own.
- `db.query` / `db.migrate` refuse structurally, in `readonly-sql.ts`, before the host runs
  (`X_MCP_QUERY_REJECTED` / `X_MCP_NOT_BRANCH_DB` — one code each, because they want different
  next commands).
- **Banned function families** — each a ban already made elsewhere in another spelling; the list
  and why lives in README's `db.query` section, held by `readonly-sql-forbidden-calls.test.ts`.
  `U&"…"` is refused, never decoded; a keyword is a whole identifier (`set2` is a column).
- Banned SQL functions are matched as a **prefix of a CALLED function name** — add a family, never
  a name (`pg_sleep_for` passed an exact `pg_sleep` ban); the call unit and the three named bans: README.
- `db.query` is defended four ways: a SELECT-only role and `BEGIN READ ONLY` in `@ultimat3/db`
  (the CLI wires them — this package never opens a `db` connection; it imports one lexer rule,
  `endOfBlockComment`, so a nested comment ends where Postgres ends it), the parse here, the caps here.
  `limit` is a request, never a permission: `resolveQueryLimits` clamps it into a hard 1000.
- The caps run in the **tool**, not the host. A host that forgets them answers a million rows
  into a model's context. `guards` names the layers that engaged; a layer that could not engage
  is absent from the list, never assumed present.
- **`MCP_RATE_LIMITS` is ENFORCED, in `handle`, and has to be there**: `rateLimitClass(body)` needs
  the parsed body and `handle` is the only parser (a `Request` body reads once). The bucket, store
  and key maths are `@ultimat3/http`'s — never a second token bucket here. Metered after the parse
  and the 401, before dispatch. Key `mcp:<class>|actor:<id>`, never the token.
- **`X_MCP_RATE_LIMITED`, not http's `X_RATE_LIMITED`**, because the knob differs: http's `fix:`
  names `rateLimit.buckets`, which does not govern this route. The 429 is `{ code, cause, fix }`
  plus `Retry-After`, never a JSON-RPC envelope.
- **A per-process store is the default and a lie for a fleet.** `mcpHttpRoute({ rateLimitStore })`
  and `defineAppMcp({ rateLimitStore })` are the seam; N replicas on the memory store enforce N x
  every number, silently and only in production. Forwarded through `defineAppMcp` deliberately —
  an app that builds its route through that one call has no other way to reach it.
- **Every authentication answer lands before `request.json()`.** A missing token, a token
  `resolveToken` rejects and a non-agent actor all return before the body is read: parsing first
  answered `400 parse error` for a malformed payload and `401` for a well-formed one under the
  SAME rejected token, which is precisely the oracle the pre-parse 401 exists to remove. The parse
  error still exists — it is what an authenticated agent gets. Failures spend a per-ADDRESS bucket
  (`seen.address`), and an exhausted address is `429` BEFORE `resolveToken` — a valid guess too.
- **Confirmation order: visibility → scope → args → `admit` → confirmation (quorum + signed
  evidence when declared) → policy.** An approval
  binds actor + tool + `keyedFingerprint(args)` (rotation ⇒ new row); `consume` (CAS) makes one approval run one
  call; rejected/expired is told once, then the call asks again. Args sealed; `approve` carries
  viewed args (digest must match); default `check`: same org. An agent never decides (in the
  policy). Statuses < 500, or `forAudience` hides the id.
- **`mcpConfirmations` also registers its gate by name** (`@ultimat3/ai`'s adapter reads it). Invalid
  args REFUSE (`X_INPUT_INVALID`), never `run()`: an action's parse drops unknown keys. First
  registered answers in-app; any server without its own asks it. Proof: `scripts/ai-tool-confirmation.test.ts`.
- **`transport-stdio.ts`'s default `write` is AWAITED** — fd 1 is a pipe, and an unawaited
  `Bun.stdout.write` lost the tail of a 4 MB frame at exit. It is also the loop's only
  back-pressure; only a child-process test can see it.
- **A schema property lands through `Object.defineProperty` too** — `@ultimat3/schema`'s
  `wire-schema.ts`, the twin of `validate-args.ts`'s `put` on the schema side. `out[key] = …` for
  a property named `__proto__` runs `Object.prototype`'s setter and re-prototypes the published
  `properties` record instead of adding a key, so a field the tool author declared vanishes from
  `tools/list` and from what the arg validator reads back.
- `transport-stdio.ts` never writes stdout except the wire (diagnostics → stderr) and caps one
  message at `DEFAULT_STDIO_LINE_LIMIT` (1 MiB): one `-32600` frame, the rest of that line discarded.
  Full rule: `docs/history/mcp.md`.
- New mutating tool ⇒ set `destructive: true`, or it is metered as cheap read chatter.
- **Invalid arguments are an `isError` RESULT (`X_INPUT_INVALID`), `As of 22.10`** — clients hide a
  `-32602` from the model. Audit outcome stays `invalid-args`. `-32602` only for a call that is not
  one. An app server renders `callerFix` (`errorAudience: 'caller'`); a `docs` other than
  `ERROR_DOCS_URL` is a 4th line — branded errors only, `fix`'s trust rule.

## Commands

```
bun test ./packages/mcp/
bun run --filter @ultimat3/mcp typecheck
```

Why each rule above is shaped the way it is: [`docs/history/mcp.md`](../../docs/history/mcp.md).
