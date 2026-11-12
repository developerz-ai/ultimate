# @ultimat3/mcp — history

The reasoning moved out of [`packages/mcp/CLAUDE.md`](../../packages/mcp/CLAUDE.md) (plan 101,
slice 17 f, `As of 2026-09-23`), verbatim and under its original headings. A record of why, never
a current fact: the rules that still hold are in that file, and where the two disagree it wins.

## @ultimat3/mcp — boundary

`@ultimat3/http` is a DIRECT dependency since 2026-08-24 (`transport-http.ts`, the rate limiter) and
was already a transitive one through `action` and `query` — declaring it added nothing to the
install graph and made the edge readable.


## Invariants

- **The RESOURCE surface owes the same three outcomes as the tool surface.** `resources/list` and
  `resources/read` take the `McpCaller`; `McpResource` carries `visibleTo` and `scope`, and
  `ResourceRegistry.resolve` applies them in the same order `ToolRegistry.resolve` does, through the
  same `visibleToCaller`. Both took no caller at all until 2026-08: any token `resolveToken`
  accepted could enumerate every URI and read every document — the manifest, the OpenAPI document,
  the route table and the entity schema, which together are an app's whole policy and data map. The
  not-found branch answered `data.available` with the full catalog, so one wrong guess enumerated
  it; it now carries no `data`, exactly as `tool not found` does. `resource-security.test.ts` is the
  contract, in both halves — hand-built resources AND `defineAppMcp({ resources })`.

- **A declared `pattern` is compiled once per schema NODE, never once per `tools/call`.** A tool's
  schema is registered at boot and validated on every call, so `new RegExp(pattern)` in `string()`
  was per-request work over a constant — `@ultimat3/schema`'s `patternTester` already draws the
  line in the same place for the same contract. The memo is a `WeakMap` keyed on the node, not a
  `Map` keyed on the pattern string: a process registering tools dynamically would otherwise
  accumulate one entry per distinct pattern forever with nothing to evict it. An uncompilable
  pattern caches its `null` verdict too — it is the branch with the highest per-call cost.
  `compiledPatternCount()` is the test-only probe (not in `index.ts`); a count that climbs once
  per CALL is the memo gone, which `validate-args.test.ts` asserts over 100 calls.

- Every outcome is audited via `audit.ts`, hidden included, at `warn`. Never log arguments
  or row data — a denial reason naming a row is a leak wearing an audit line's clothes.
  **On both surfaces**: `mcp.tool-call.<outcome>` from `toolsCall`, `mcp.resource-read.<outcome>`
  from `resourcesRead`, one `LEVEL` table and one field builder behind them. `resources/read`
  emitted nothing at all until 2026-08-23, so a URI walk over the four documents that describe an
  app's whole policy and data map left no trace while the identical walk over tool NAMES was one
  `warn` per attempt. Two EVENTS and not one, because an alert that buckets a document read as a
  tool call cannot tell the two walks apart. `resources/list` and `tools/list` are both silent by
  design — each is answered pre-filtered, so it reveals only what the caller could already see.
  `resource-security.test.ts` reads BOTH streams: core's logger puts `error` on stderr.

- **A `--` comment ends at the first CR *or* LF, because that is Postgres' own boundary set**
  (`readonly-sql.ts`). `non_newline` is `[^\n\r]`, so a bare CR ends the comment for the SERVER
  and did not for this scanner: `select 1;--\rupdate members set role='admin'` was one statement
  with no mutating keyword to all five layer-3 checks at once — the statement split, the read-leader
  check, the write-keyword scan, the forbidden-call scan and the `FOR UPDATE` regex all read the
  stripped form — and `verbatim()` handed the caller's bytes back to run. `endOfLineComment` is the
  lexer's set, never one character of it, the same shape `skipSingleQuoted` already had.

- `actions:`/`queries:` take the **real primitives** (`actions: [publishPost]`), adapted by
  `projectable.ts` into the same `ProjectablePrimitive` the registry sweep builds. They took
  `ProjectablePrimitive` alone until 2026-08, which no `action()` or `query()` satisfies — they
  carry `as`/`tool`, never `run` — so listing one was a TS2741 and the only value that could
  reach `X_MCP_TOOL_UNDECLARED` was a hand-built fake. A gate that no declaration can reach
  refuses nothing. `ProjectablePrimitive` stays in the union for surfaces that build a catalog
  programmatically (`@ultimat3/admin`); `isAction`/`isQuery` read each package's private
  declaration store, so a look-alike falls through instead of borrowing `invoke`.

- **This package NAMES a tool, it never derives one.** `primitive.mcp?.name ?? primitive.name` in
  `from-action.ts` is the whole rule, fed the verbatim export name by `projectable.ts` — a
  transform here would be a second spelling of a name that is already an addressable identity.
  Every surface that PUBLISHES the name owes the same string: `action.tool()`, `query.tool()`,
  `x-ultimate.mcpTool`, `ActionDescriptor.mcp.tool`. The three action publishers snake_cased it
  through `toToolName` until 2026-08, so a spec-reading agent called `publish_post` and got
  `-32601` from a catalog holding `publishPost`, and nothing noticed because no test compared the
  served name to a published one. `cross-surface.test.ts` is that comparison — it reads the
  catalog off `tools/list` and drives a `tools/call` with the name OpenAPI published, so a
  publisher that re-derives is a failing test and not a wiki note.

- `pg_notify` and the server-control / replication families are banned for the reason every other
  family is: the same ban already exists in another spelling. `notify`/`listen`/`unlisten` are
  WRITE KEYWORDS, so `pg_notify()` is `NOTIFY` as a call the keyword scan cannot see;
  `pg_cancel_backend`/`pg_terminate_backend` establish that server control belongs, so
  `pg_reload_*`, `pg_rotate_*`, `pg_switch_*`, `pg_promote` and `pg_wal_replay_*` join them; and
  `pg_logical_slot_get_changes` is `nextval`'s argument exactly — it advances a slot's confirmed
  position, a write with no keyword that no `ROLLBACK` undoes — which brings `pg_create_*`,
  `pg_drop_*`, `pg_replication_*` and `pg_logical_*` with it. `pg_file_*` is the writing half of
  `pg_read_*`. `txid_current`/`pg_current_xact_id` ASSIGN a transaction id a rollback does not
  return. The catalog VIEWS beside them (`pg_replication_slots`, `pg_stat_replication`) are read
  `from` and never called, so the call scan never sees them.

- Banned SQL functions are matched as a **prefix of a CALLED function name**, so the family is the
  unit and a spelling nobody wrote down is refused rather than admitted — an exact-name list let
  `pg_sleep_for` past a ban on `pg_sleep`, and `set_config` past `SET`, which is already a write
  keyword. Add a family, never a name. The unit is the call (`name` before `(`), never a bare word:
  a word scan refused a column named `pg_sleep_for_seconds`. The call scan reads a strip that KEEPS
  quoted-identifier content, because `"pg_advisory_lock"(1)` is the same call as the bare spelling —
  the keyword scan still reads the blanked form, so `select "update" from t` stays a column. Two of
  the families exist because the same ban is already made elsewhere in another spelling:
  `pg_advisory_*` is `FOR UPDATE`'s ban and the worse breach (a session lock survives layer 2's
  `ROLLBACK`, so it outlives the read on a pooled connection — proved live in
  `packages/testing/src/db-integration.test.ts`), and `pg_sleep*` is the one ban that still holds on
  embedded PGlite, whose single WASM thread cannot honour a statement timeout. `nextval`/`setval`
  are a family no keyword can reach: they advance a SEQUENCE, which is a write, and one `ROLLBACK`
  does not undo — a consumed id is gone, so a read can burn the next id a real insert would take.

- **`MCP_RATE_LIMITS` is ENFORCED, in `handle`, and it has to be there** (2026-08-24). `limits` and
  `rateLimitClass` were published on `McpRouteDescriptor` and read by no mount point — `x mcp serve`
  runs `route.handle` in a bare `Bun.serve` and `defineAppMcp` hands its route to the app — so the
  type promised 20 writes a minute while the real ceiling was Bun's accept rate: an agent looping on
  `db.query` was never UNSAFE (the `readonly-sql` parse and `query-limits` caps hold per call) and
  never BOUNDED. It cannot be enforced from OUTSIDE, which is why deleting the option was the wrong
  half of the choice: `rateLimitClass(body)` takes an ALREADY-PARSED body and `handle` is the only
  thing that parses one, so a limiter above it would have to consume the request stream first and a
  `Request` body reads once. The maths, the `Bucket`, `toBucket`, `rateLimitKey` and the store are
  `@ultimat3/http`'s — tier 2, a legal downward import — and **never** a second token bucket written
  here. Metered after the parse and before dispatch; an unauthenticated caller is answered 401 first,
  so a token nobody issued cannot spend an actor's allowance. The key is
  `mcp:<class>|actor:<id>`, never the TOKEN: a bucket key reaches a log and an error reporter, and a
  credential in one is a leak wearing a throttle's clothes.

- **`X_MCP_RATE_LIMITED`, not `@ultimat3/http`'s `X_RATE_LIMITED`, and the reason is the KNOB.** The
  enforcement is shared to the last function; only the sentence differs. `X_RATE_LIMITED`'s `fix:`
  says to raise `rateLimit.buckets` in `app.config.ts`, which governs the HTTP pipeline and has no
  effect on this route — an instruction that runs and changes nothing is worse than none, which is
  the same call `@ultimat3/realtime`'s `SubscriptionLimitError` makes when it names the knob rather
  than the default. The 429 renders `{ code, cause, fix }` plus `Retry-After`, the shape this file's
  401 and 403 already use, never a JSON-RPC envelope: the transport refused before dispatch, so
  there is no call to answer.

- **`transport-stdio.ts`'s default `write` is AWAITED, and it has to be** (`As of 2026-09`). It was
  `Bun.stdout.write(chunk)` returning `void`, so every `await write(...)` in `serveStdio` awaited
  nothing: fd 1 is a pipe for every real peer (a local agent LAUNCHED this process), the runtime
  queues past the buffer, and the CLI's exit threw the queue away — measured, a 4,000,236-byte
  frame arrived as 1,388,672 bytes. The same failure `scripts/stdout-truncation.test.ts` pins for
  `--json`, and it needs a CHILD PROCESS to see: in-process it does not exist. Awaiting it is also
  the loop's only back-pressure.

- **Invalid arguments are a tool RESULT, not `-32602`** (`As of 22.10`). A consumer measured it: an
  agent that sent a mistyped argument got a protocol error its client showed the HUMAN and withheld
  from the MODEL, so the model retried the same call blind. MCP's own guidance is that an error the
  model can correct belongs in the result. The code is `X_INPUT_INVALID` — `@ultimat3/action`'s
  `InputInvalidError`, the code HTTP answers for the same input and the one a hand-written tool's own
  parse already threw — so one mistake reads one way on every surface. The audit outcome stays
  `invalid-args`: what changed is the wire, not what the server decided.

- **`callerFix` beside `fix`, never instead of it.** `X_FORBIDDEN`'s fix is `x policy explain …`: right
  for the author, a dead end for a remote agent and a leak of how the app is operated. Replacing it
  would take the command from the log line the developer reads; so the error carries both and the
  RENDERER picks by audience — `defineAppMcp` and a production problem document the caller's, the
  terminal, `--json`, dev mode and the dev server the developer's. One sentence
  (`deniedCallerFix` in core) for the five packages that deny, so a caller reads the same instruction
  whichever layer said no.

- **`destructiveHint: true` is the derived default for every action.** The framework cannot tell an
  insert from a delete, the spec's own default is `true`, and a client uses the hint to decide what
  to confirm with a human — so `false` is a statement only the author can make
  (`mcp: { annotations: { destructiveHint: false } }`). `openWorldHint` is never derived for the same
  reason: whether a write sends mail is not in the declaration.

- **`outputSchema` is structure only.** A client validates `structuredContent` against it and refuses
  the call on a miss; a query's rows are read from the database and never re-parsed, so a bound, a
  pattern or `additionalProperties: false` there is a promise about a value nothing checks on the way
  out. Type, properties, required, items, enum, const and anyOf are what the answer's SHAPE is.

- **Compact text, and `list_resources` as plain lines.** A staff catalog measured 32.5k characters as
  2-space JSON; the model is its only reader and pays for every indent for the rest of the session.
  `describe_resource` stays JSON because a schema is JSON. The budget is a test an app writes
  (`assertMcpSurfaceBudget`), not a framework ceiling: the right number is the app's measurement.

## Moved 2026-10-07 — `Object.hasOwn` for a declared key

The inherited-key defect in `validate-args.ts` (`constructor`, `toString`, `hasOwnProperty`,
`__proto__` read as declared) was the third instance of the class in the framework, after
`@ultimat3/i18n`'s catalog lookup and `@ultimat3/schema`'s `coerce`. The rule itself stays in
[`packages/mcp/CLAUDE.md`](../../packages/mcp/CLAUDE.md).

## `\'` inside a string literal (moved from `packages/mcp/CLAUDE.md`, 2026-10-18)

**`\'` inside a string literal is refused** (`readonly-sql.ts`). `E'\''` is one quote to
  Postgres and `standard_conforming_strings` decides the plain spelling, so the two readings
  disagree about where the string ends — which is exactly where a `;` hides.
  `select E'\'' ; drop table posts --'` was accepted as one read-only statement and handed back
  verbatim to run. Only inside a single-quoted run: a comment, a `$tag$` body and a quoted
  identifier are unambiguous and still read fine.

## An unterminated run (moved from `packages/mcp/CLAUDE.md`, 2026-10-18)

**An unterminated run is refused, never swallowed** (`readonly-sql.ts`). The stripper blanks what
  it believes is inside a literal, so an opening delimiter that never closes hid the whole tail:
  `select '; delete from members` counted one statement with no mutating keyword and was handed
  back to run. All four forms now throw `X_MCP_QUERY_REJECTED` — `'`, `"`, `$tag$`, `/* */`. Not
  exploitable through Postgres (a syntax error either way); the point is that this layer must not
  be the thing that waves it through. `@ultimat3/admin`'s `/_x` panel failed CLOSED here where this
  failed open, which is how it was found — a second, differently-behaved copy of one rule.

## Moved out 2026-11-03 (plan 101 wave 4c, the `CLAUDE.md` ceiling)

- **A thrown value is a framework error only when its `code` matches core's `FRAMEWORK_CODE`,
  never `code.startsWith('X_')`** (`As of 2026-09`). `asFrameworkError` substitutes
  `x errors explain ${code}` when a coded throw carries no `fix:`, so the code lands in a COMMAND
  an agent is told to run — and a prefix test admits `X_$(id)`. A value that is not a code spelled
  the one way takes the `-32603` branch, which leaks nothing of the throw. One pattern, core's,
  because `@ultimat3/core`'s `client-wire.ts` already had to answer the same question for a
  problem document off the wire.
- **A key's membership of a declared schema is `Object.hasOwn(properties, key)`, never
  `properties[key] === undefined`.** The arguments of a `tools/call` are NAMED by the caller, and
  `Object.prototype` supplies a value for `constructor`, `toString`, `hasOwnProperty` and
  `__proto__` on every plain object — so the index read answered "declared" for four names no
  schema declares, and `validate-args.ts` accepted them past an `additionalProperties: false` that
  forbids them and then dropped them. Its twin: a validated key
  lands on the result through `Object.defineProperty`, because `out[key] = v` for `__proto__` runs
  the setter on `Object.prototype` and re-prototypes the record instead of adding a key.
- **Every provider call is inside a `try`.** A resource's `read` is an INJECTED THUNK —
  `frameworkResources` wires it to a file read, and `Bun.file(...).text()` on a missing
  `x.manifest.json` throws ENOENT. Outside the try it escaped `handle()`: `serveStdio` REJECTED with
  the raw error, zero frames written, the request unanswered and every later request on that buffer
  never processed. Same shape `toolsCall` uses — a framework error keeps its code/cause/fix, anything
  else is `-32603` with no internals.
- **`format` is NOT in the wire subset**, and `wire.ts` types it `never` so re-adding it does not
  compile. It names a rule whose meaning lives in `@ultimat3/schema` (`uuid`, `email`,
  `iana-time-zone`), and this package cannot check it without a second definition of each that can
  only drift from the action's own parse. `tools/list` published it and `validate-args.ts` ignored
  it, so a tool declaring `t.uuid` accepted `"not-a-uuid"` with `ok: true`. `pattern` is the
  opposite case and is kept: the rule travels with the schema. The narrowing is `@ultimat3/schema`'s
  `toWireSchema` (tier 0, so OpenAPI-adjacent readers reach the same document) and the
  type is its `WireJsonSchema`, which `wire.ts` names `JsonSchema`; `validate-args-subset.test.ts`
  asserts every published keyword is one this server enforces, at any depth.
- `transport-stdio.ts` never writes stdout except the wire. Diagnostics → stderr. It also **caps one
  message** at `DEFAULT_STDIO_LINE_LIMIT` (1 MiB, the same figure `transport-http.ts` enforces with
  `readWithinLimit`) — the peer launched this process and is trusted, a bug in it is not, and a
  stream with no newline grew the buffer until the process died. Over-long is one `-32600` frame
  carrying a `fix`, then the rest of that line is DISCARDED to the next newline: what follows an
  over-long message on the same line is its tail, never a message of its own.

### 2026-11: dual-era (MCP 2026-07-28)

Read from the spec on 2026-11-02: the current revision `2026-07-28` drops `initialize`; version, client info and capabilities ride in each request's `_meta`, `server/discover` is mandatory, and the compatibility matrix says a modern client on a legacy server **fails** — only a dual-era client falls back. Probes through `route.handle` that day: `initialize` offering `2025-11-25` or `2025-03-26` answered `2025-06-18` both times; `resources/templates/list` was `-32601` while `resources` was advertised; `MCP-Protocol-Version: garbage` was a 200; `Origin: https://evil.example` with a token was a 200 (the spec requires 403); `x mcp serve` answered GET and DELETE `404` (the spec says 405).

Decisions: the era is per request, never per connection (no session state exists to hold one). A `_meta` version naming a LEGACY revision is served as that revision rather than refused — `-32022`'s `supported` lists the legacy revisions, so refusing them in `_meta` would loop a client retrying from that list. `Origin` is core's `proveSameOrigin` (honouring `http.cors.origins`), never a list of this package's own; an audit reproduced that a Host-derived self origin admits a DNS-rebound page, so `x mcp serve` checks the Host as `/_x` does (421). `MCP_PROTOCOL_VERSION` was deleted rather than repointed, because a constant that silently changed era would mislead every caller that compiled. No `allowedOrigins` option: `POST /mcp` sends no CORS headers (`cli/src/app-mcp.ts`), so a browser client cannot read an answer today, and non-browser clients send no `Origin`; the option arrives with the first browser client. `ttlMs: 0` / `cacheScope: 'private'` because every list is filtered per caller; a longer TTL is a later knob, with evidence. Not shipped and not advertised: `subscriptions/listen`, multi-round-trip input, the tasks extension, `x-mcp-header`, SSE responses — long work stays `.job()` plus a query.

### 2026-11: the authorization server moves in (plan 101, item 41)

Reversed: `app-tools.ts`'s "the authorization server — consent, `/oauth/token` — is the app's own
routes". Measured before the reversal: four copies in adopting apps (1,636 LOC on this framework,
1,068, 1,139, 1,548) and a fifth run as a separate service, each holding the same RFC-fixed rules
— exact redirect match, S256 only, single-use codes, refresh rotation with replay revocation,
RFC 8707 resource binding, RFC 9207 `iss`. The same for a bank and a blog, so mechanism (axiom 8).

Decisions:

- **The server is `@ultimat3/auth`'s, from birth** (`authorization-server*.ts`): a public API, an
  integration or a CLI needs the same wire, and `bearerMount` already takes any resolver. This
  package holds only `oauth-server.ts`, the `resource`-binding wrapper and its `mcp.auth.<event>`
  lines. No `X_MCP_OAUTH_*` code: the refusals are auth's.
- **auth imports nothing from http** (same tier): `routes` are plain objects that assign to
  http's `Route` by structure and `oauthBearerResolver` returns a `BearerResolver` by structure.
  The assignment is compiled, without a cast, in `oauth-bearer-mount.contract.test.ts` — here,
  because mcp is the lowest package that may import both.
- **The wrapper defaults the resource.** A client naming no `resource` gets a grant bound to the
  endpoint, never an unbound one; `resolveToken` refuses unbound and foreign tokens alike. Auth's
  own default stays unbound (a resolver with no `resource` accepts it).
- **No `McpAuditEvent` arm.** The server's decisions are log lines (`mcp.auth.issued`, `…refused`,
  `…revoked` at info; `…code-replayed`, `…refresh-replayed`, `…grant-disabled` at warn) and the
  app's `onEvent`. Widening `McpAuditEvent` would break every exhaustive `switch` over `onAudit`
  for an event the gate did not decide.
- **Tokens are opaque, hashed at rest** (`xat_`/`xrt_` prefixes, 32 random bytes), never a JWT, so
  `revoke` holds on the next lookup. Lists are space-joined text in Postgres: scope-tokens and URIs
  hold no space, and no array parameter has to cross `Bun.SQL`.

## Agents on the wire, remote tools, job tools, recipes (As of 2026-11, plan 101 slices 41 / 39)

Compared before the design was fixed, read only (never run): sst/opencode at
[`b60984d6`](https://github.com/sst/opencode/tree/b60984d68ad959524bd1036b00d6ebf8f473fd07)
(`packages/core/src/mcp/client.ts`, `packages/server/src/handlers/event.ts`) and badlogic/pi-mono at
[`e12dbfc9`](https://github.com/badlogic/pi-mono/tree/e12dbfc9299049dc2e7a974612fec32001a7ba8a)
(`packages/mcp/src/{client,output-limit,naming}.ts`, `transports/streamable-http.ts`,
`packages/agent/src/{types,proxy}.ts`).

| Question | opencode | pi | Ultimate |
|---|---|---|---|
| Tokens to a client | an app-wide SSE event bus, `: heartbeat` every 15 s | `ProxyAssistantMessageEvent`: the provider events with `partial` stripped for bandwidth | the action's own route, `accept: text/event-stream`; `chunk`… then one `done` or `error`; `: keep-alive` every 15 s. A stream is one caller's answer with its policy and budget, so not a channel |
| Agent events | per-message parts | `turn_start/end`, `tool_execution_start/end` with ids | `agent()` chunks `text`, `tool_call {id,name}`, `tool_result {id,name,isError}`, `turn` — ids pair a call with its result as pi's do; no arguments, no tool output, no transcript (the `onTurn` line) |
| Remote tools found | listed on connect, relisted on `list_changed` | listed on connect | NEVER at run time: `allow` + committed `tools.lock.json` (`x mcp lock`); a drift is `X_MCP_REMOTE_TOOL_CHANGED`. Both references trust the live list; a changed description is a prompt-injection channel |
| Transport | the SDK's streamable HTTP; session + DELETE on close | its own: `Mcp-Session-Id`, 404 → session expired, SSE answers, `Last-Event-ID` resume | `outbound()` (deadline, dial screen, size cap); modern era first, legacy `initialize` + `Mcp-Session-Id`, one re-initialize on 404; an SSE answer read for its `id`. No GET stream, no resume: a tool call is one request |
| Cancellation | the SDK's abort | `notifications/cancelled` on abort | the call's `ctx.signal`; legacy era also sends `notifications/cancelled`, best effort and logged |
| Result size | timeouts per phase | 20 KiB, middle cut (Codex's format) | `maxResultChars` (20,000), middle cut, inside an `<untrusted source=…>` fence the remote cannot close |
| Tool naming | server-prefixed | `mcp__<server>__<tool>`, hashed past 64 | `<server>_<tool>`, `[A-Za-z0-9_]`, 64 — an action name, the model's tool name |
| OAuth to the upstream | full client flow, stored tokens | auth provider | not in the framework: `auth: () => headers` per call; the app owns the token store |

## Moved out 2026-11-07 — `include-early.ts` (sweep 3, the `CLAUDE.md` ceiling)

- `include-early.ts` keeps what `include: 'exposed'` saw — a `WeakMap` keyed by the `AppMcp` — and
  `assertIncludeCurrent(endpoint, file)`, the mount's check after the boot scan. A catalog projected
  at the top level of a module under `apps/<app>/app/` is built before the scan reaches another app
  directory's actions; the mount refuses it with `X_MCP_INCLUDE_EARLY`, naming the primitives the
  too-early catalog lacks and the `apps/<app>/mcp.ts` to build it in, instead of serving it short.

## Exposure is declared at the primitive (moved from CLAUDE.md, `As of 2026-11-09`)

- Exposure is declared at the primitive, never in `defineAppMcp`. A primitive NAMED in
  `actions:`/`queries:` without `mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot —
  a written-out list is a request, so filtering it would ship a catalog missing a tool its
  author believes is there. `include: 'exposed'` sweeps the registries and therefore skips,
  because that list is every primitive the app registered, not one anyone wrote out.
  `actions:` and `queries:` go through **one** `toolsListed` call over the concatenation: it
  collects every offender before throwing, so one boot names all of them and one edit closes
  all of them. Two calls would throw on the first array and never examine the second.

## Moved out 2026-11-12 (sweep 11, the CLAUDE.md ceiling)

- **A schema property lands through `Object.defineProperty` too** — `@ultimat3/schema`'s
  `wire-schema.ts`, the twin of `validate-args.ts`'s `put` on the schema side. `out[key] = …` for
  a property named `__proto__` runs `Object.prototype`'s setter and re-prototypes the published
  `properties` record instead of adding a key, so a field the tool author declared vanishes from
  `tools/list` and from what the arg validator reads back.
- **`transport-stdio.ts`'s default `write` is AWAITED** — fd 1 is a pipe, and an unawaited
  `Bun.stdout.write` lost the tail of a 4 MB frame at exit. It is also the loop's only
  back-pressure; only a child-process test can see it.
