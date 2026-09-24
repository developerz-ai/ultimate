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
