# Troubleshooting

Symptom → cause → fix. Every `X_*` error already carries its own cause and exact fix command; this page is for symptoms that do not start with a code.

## Triage

Run these first, in this order. All support `--json`.

| Command | Answers |
|---|---|
| `x doctor --json` | Bun version, env schema, DB/transport/storage reachability, port conflicts |
| `x verify --json` | the gate — 17 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap |
| `x errors explain <CODE> --json` | cause, fix command, docs URL for any `X_*` code |
| `x doctor --json` | environment, versions, drift, ports, PWA prerequisites — each with a fix |
| `x dev` then `/_x` | the live panels: routes, timeline, jobs, db, mail, cache, policy, manifest |
| `x status --json` · `x logs tail --json` | **planned**, not shipped — both throw `X_NOT_IMPLEMENTED` naming the two rows above ([CLI reference](CLI-Reference)) |

The `--json` form is the same content as the terminal form. Paste the JSON into a bug report; do not paraphrase the terminal.

## Boot and env

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits in ~40ms, `X_ENV_MISSING` | a key in the `defineEnv` schema is missing, or present but fails its schema (short secret, non-URL, bad enum) | the cause names every offending key and its constraint at once; `x doctor --json` lists them too |
| `X_CONFIG_INVALID` at load | `app.config.ts` field invalid — `defaultLocale` not in `locales`, `db.pool < 1`, non-IANA `timeZone`, `realtime.transport` set without `realtime.url` | `x config show --json`, then edit the field named in `cause` |
| `X_ROLE_INVALID` | `ROLE` is not one of `web sync worker scheduler migrate replicator all` | fix the env var on that service |
| `X_BUN_VERSION` | below the Bun 1.3 floor | upgrade Bun |
| Container starts then loops | `/readyz` failing, not `/healthz` — usually DB unreachable or a migration version mismatch | `curl /readyz` and read `checks[]`; it names the failing check |
| Config edits have no effect | you edited a per-environment file that does not exist — config is **one file** | put the difference in an env var ([Configuration](Configuration)) |

## Database

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations (a column added by hand, or a generated migration never applied) | `x db gen "<message>"` then `x db migrate` |
| `X_DB_DRIFT` on a brand-new app, cause *packages/db has a schema but no migration recorded it* | expected: `x new` writes no migration, and `x db gen` is the only writer of `packages/db/migrations`. Only an app that declares an entity reports it — zero declared against zero recorded is agreement | `x db gen "initial"` then `x db migrate` — `bin/setup` does both |
| `X_DB_DRIFT` after deleting the last entity, migrations still committed | correct, and not the case above: the migrations record tables the source no longer declares | `x db gen "drop <table>"` → it refuses with `X_MIGRATION_IRREVERSIBLE` → re-run as `x db gen "drop <table>" --allow-destructive`, or put the entity back |
| `X_MIGRATION_SNAPSHOT_MISSING`, and `x db gen` refuses before writing anything | the newest migration on disk carries no `.snapshot.json` — hand-written, or the sidecar was deleted | `git checkout -- packages/db/migrations/<id>.snapshot.json`; if it was never written, `rm packages/db/migrations/<id>.* && x db gen "<name>"` — the delete **first**, or the generate refuses again |
| `ROLE=migrate` sits there doing nothing | another version's `ROLE=migrate` holds the session-pinned advisory lock — this one **waits**, it does not error (`X_MIGRATE_CONCURRENT` is reserved, never thrown) | let the first exit 0; the second then applies. If nothing else is deploying, look for a backend still holding `pg_advisory_lock` in `pg_locks` |
| `ROLE=migrate` exits non-zero, deploy blocked | migration failure — correct, the roll is supposed to stop | read the SQL error, fix the migration, re-run. Do not start `web` on the old schema |
| `X_TIMEOUT` on one query | past `db.statementTimeout` (default `'10s'`) | add the index the plan wants, or narrow the query. Raising the timeout hides it |
| Connection exhaustion under load | `db.pool` × replicas × roles exceeds Postgres `max_connections` | lower `db.pool`, or a pooler in front |
| Every test suddenly slow | the template DB is being rebuilt per worker | `x test --json` reports template build time; check migrations that are not idempotent |

## Import boundaries

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_BOUNDARY_VIOLATION` on a file that imports nothing suspicious | a **transitive** chain — the error prints it, e.g. `site/pricing → shared/ui/button → app/billing/service` | break the chain at the lowest hop; move the shared piece into `shared/` |
| `X_BOUNDARY_SITE_TO_APP` | a `site/` route reached into `app/` | duplicate the small thing, or move it to `shared/`. `site/` must stay 0kb JS |
| `X_BOUNDARY_SHARED_LEAF` | `shared/` imported `site/` or `app/` | `shared/` is a leaf, always |
| `X_BOUNDARY_ROUTE_TO_DB` | a route file queried the DB | route → `service.ts` → `repo.ts`. Only `repo.ts` touches SQL |
| `X_BOUNDARY_SERVICE_TO_HTTP` | a service imported request/headers | a service that knows about requests cannot be reused by a job |
| Tier violation in a framework package | imported sideways or upward | `bun run boundaries`; consult the tier table in [Contributing](Contributing) |

Boundaries run on pre-push and inside `x verify`. They are build errors, never lint warnings.

## Budgets, SEO, i18n

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_BUDGET_EXCEEDED` on `js` | one import pulled a library into a surface | the error names the **import chain**; `x routes --json` for per-route budgets |
| A `site/` route reports non-zero JS | a component with client state leaked into the static surface | move it to `app/`, or set `hydrate: 'never'` |
| LCP or CLS regression | an unsized image or a late-loading font | `x routes --json` for the route's budget; images go through the pipeline, never a raw `<img>` |
| `X_SEO_META_MISSING` | an indexable route's `meta` has no `title`, or no `description`. One code for both — `cause` names the field and the file | add it to the route's `meta`. Deleting a description is a build error, by design. Over-length is a different code, `X_SEO_META_TOO_LONG` (title > 60, description > 160). `X_SEO_NO_TITLE` / `X_SEO_NO_DESCRIPTION` are design-doc names that were never implemented ([Error codes](Error-Codes#names-used-in-the-design-docs)) |
| `X_ROUTE_META_MISSING` | a route has no `meta` at all | every route sets `render`, `offline`, `hydrate`, `meta` |
| `X_CATALOG_MISSING_KEYS` | a key exists in one locale's catalog and not another | the cause lists key + locale; add the translation. There is no silent English fallback |
| `⟦some.key⟧` rendered in the UI | the key is missing everywhere | add it to the default catalog; `x verify` fails until you do |
| Lighthouse gate fails | below `seo.lighthouse.seo` (100) or `accessibility` (95) | fix the audit, don't lower the threshold |

## Jobs

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_IDEMPOTENCY_REQUIRED` (compile error) | `idempotencyKey` omitted — it is required by the type | add an `idempotencyKey` derived from `input` only, e.g. `onboard:${orgId}` |
| `X_STEP_DUPLICATE` | two `step.run` calls with the same name in one `run` | rename one. Step names must be unique and stable |
| A step re-ran after a deploy | the step was **renamed** — renaming invalidates its stored result | treat a rename as a new step; keep old names |
| `X_IDEMPOTENCY_CONFLICT` | same key, different input, inside the dedupe window | the key is not deterministic from `input`. Remove the timestamp or random part |
| Job stuck "in-flight" after a worker was killed | the lease has not expired yet | wait `jobs.visibilityTimeout` (default `'30s'`); the row is re-claimed and resumes at the **next** step, never mid-step. `x jobs show <id> --json` |
| Job in dead-letter | `retry.attempts` exhausted | `x jobs show <id> --json` for the step trace, then `x jobs retry <id>` — it replays from the failed step |
| Nothing is processing | no `worker` for that queue name | check `WORKER_QUEUES` against `jobs.queues` |
| A job ran but the row it needs doesn't exist | enqueued outside the transaction | enqueue via `<job>.enqueue` inside the action's `handle`; `X_OUTBOX_NO_TX` catches the rest |
| Cron never fires | no `scheduler`, or the standby is holding | `scheduler` is fixed at 1 active; a standby reports not-ready by design — check `/readyz` |

## Realtime

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_TRANSPORT_UNAVAILABLE` | fanout bus unreachable — `NATS_URL` names a server nothing answers on | `x doctor`; set `NATS_URL`, or unset it for in-process fanout |
| `X_TRANSPORT_PROTOCOL` | nats-server older than 2.11, started without `-js`, or something other than NATS on the port | presence needs batch direct get and per-message TTL — run `nats:2.11-alpine` or newer with `-js` |
| Live query rejected at build | unbounded — missing `orderBy` or `limit` | add both. An unbounded result has no bounded change buffer and no bounded reconnect snapshot |
| Live query rejected for non-determinism | `now()` / `random()` in the `sql` | move it to `input`; the same `(input, row)` must always yield the same membership answer |
| `X_SUBSCRIPTION_LIMIT` | a socket, tenant or node hit a cap — the error names which scope refused, and channel topics have their own | **live queries:** raise `maxPerSocket` / `maxPerTenant` / `maxEntries` on the `LiveQueryRegistry` (per socket, default 128), or unsubscribe unused ones. **Channel topics:** raise `maxTopicsPerSocket` (default 64) / `maxTopicsPerNode` (default 10,000) on the `ChannelHub`. None is an `app.config.ts` field → [Configuration](Configuration) |
| `X_CURSOR_STALE` | resume cursor outside the change buffer window — or a reconnect that landed on a `sync` node which never served that `qid`, since the ring is per node | raise `capacity` on `new RingChangeBuffer({ capacity })` (default 1024), or pass `'snapshot'` to `resumeFrom()` so the fallback re-snapshots. Not an `app.config.ts` field → [Configuration](Configuration) |
| `X_TOPIC_FORBIDDEN` | tier-1 topic guard denied the actor | fix the topic scope; the cause names actor + topic, never the topic's data |
| Reconnect storm after a deploy | drain was truncated by SIGKILL, so no `reconnect` frame was sent | set `stop_grace_period` / `terminationGracePeriodSeconds` >= `DRAIN_TIMEOUT` ([Deployment](Deployment)) |
| Reconnects still spiky with a clean drain | not a config field — `realtime.drain.*` does not exist. A draining node sends a `reconnect` frame carrying a per-client `afterMs`; if clients still stampede, they are reconnecting on their own `backoffDelay()` because no frame reached them | confirm the drain path actually ran — a `SIGKILL` sends no frame, which is the case the 50k benchmark measures → [Configuration](Configuration) |
| A channel message never arrived, and nothing errored | backpressure. `channel_frames_dropped_total` moved and `channel.frames_dropped` names the topic — a channel has no cursor and no re-snapshot, so a dropped frame is not replayed | put anything that must arrive on a live query, which repairs. Alert on any non-zero rate → [Observability](Observability) |
| A client is connected but receives nothing, and never reconnects | half-open socket: the TCP connection died without a `close`, so no handler fired | the client's heartbeat ends it — `new LiveClient({ heartbeatMs })`, default 15s, two silent windows then close `4000`. A `heartbeatMs: 0` disables that and is the only way to be stuck here → [Realtime](Realtime) |
| Topics silent after the first reconnect, live queries fine | a client that does not re-announce its topics. **`hello` carries nothing to resume with** `As of 2026-08` — no cursors, no membership; a `subscribe` frame carries both, one per topic and one per live query with that subscription's cursor | `LiveClient` re-sends all of them on open. A hand-written client must send one `subscribe` per topic **and** one per live query carrying its resume cursor, or the topics are silent, presence sweeps the membership, and every live query re-snapshots → [Realtime](Realtime) |
| Every client re-snapshots for the length of a deploy | the `qid` hash changed with the framework version, so a resuming cursor names a ring entry the new node does not have | expected and correct: the miss falls back to one bounded snapshot per subscription. It ends when the rollout does |
| A row appeared that the user shouldn't see | not possible via the framework path — policy is re-checked per delivered row. Suspect an unscoped predicate | `X_TENANCY_UNSCOPED`; tenant scope comes from `ctx`, never from `input` |
| `sync` never becomes ready | replication feed lag over threshold, or NATS not subscribed | check the `replicator` first — it owns the slot |

## PWA, build skew, deploys

| Symptom | Likely cause | Fix |
|---|---|---|
| White screen after a deploy, 404 on a lazy chunk | version skew — a build-`A` client asked for a build-`B` asset outside retention | raise `pwa.retention.deploys` / `.window` (default 10 deploys or 7d, whichever is longer) |
| `X_BUILD_SKEW` on an action | the input schema changed incompatibly since the client's build | the `fix:` line names the action; version the action instead of changing it in place |
| Users stuck on an old version | your app never renders the `AppUpdateAvailable` affordance | subscribe to the signal and show "Update available — reload". The framework never force-navigates |
| Need everyone off a build now | security patch | `x deploy --critical` sets a grace deadline (default 30m); clients count down, drain state, then reload |
| `X_SW_HAND_EDITED` | `sw.js` was edited — its checksum no longer matches | revert it and change the **route**; `sw.js` is a build artifact |
| `X_SW_UNCACHEABLE` | `offline: 'precache'` on an `ssr` route | caching a per-request render is a correctness bug. Use `runtime` or `network-only` |
| Precache budget failure | too many `precache` routes or oversized assets | `x build --json` reports the set; drop routes to `runtime` |
| Offline shows the browser dinosaur | `pwa.offline.fallback` missing — normally a compile error | add `offline: { fallback: '/offline' }` |
| Preview build poisoned a cache | impossible via the framework — build ID scopes the SW cache namespace and scope | confirm the branch build ID in `x manifest --json` |

## Tests

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_SEALED` | a test reached the network unmocked | the error names the URL. Mock it — sealed network is the design, not a bug |
| A test passes alone, fails in the suite | shared state that should not exist — each worker gets its own cloned DB | check for a module-level singleton or a fixture written outside `seed()` |
| Time-dependent failure | asserted on wall clock | use the frozen clock and `clock.advance('3d')` — it also drives `step.sleep` and cron |
| A test flakes | **fix it or delete it the same day** | there is no `retry: 3`. A test that passes twice and fails the third trains people to ignore red |
| Snapshot/UUID churn between runs | not using `seed(name)` | seeds are deterministic: same input → identical rows, identical UUIDs |
| Job test doesn't drain | queue not advanced | `await runJobs.drain()`; workers run deterministically in tests |
| Want the failing worker's database after the run | there is **no** `--keep-db` — `x test` declares `--workers`, `--worker`, `--filter` and `--sample` and nothing else, and the harness calls `drop()` at teardown ([`packages/testing/src/harness.ts:108`](https://github.com/developerz-ai/ultimate/blob/main/packages/testing/src/harness.ts)) | what survives is the migrated template, `ultimate_test_template` — the clones are `ultimate_test_template_w<N>`. Inspect the template: `psql "$TEST_DATABASE_URL" -c "\l"`, then connect to it. To hold a clone open, assert inside the test rather than after it |

## MCP and AI

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_MCP_TOOL_UNKNOWN`, or a tool absent from `tools/list` | the tool is hidden from this caller, or the name is stale — role-hidden and absent answer identically, on purpose | visibility is fail-closed: check the caller against the tool's `visibleTo` (a role allowlist or a predicate over the caller). Otherwise `tools/list` for the catalog this caller may use, and `x manifest` if the committed manifest is stale |
| `X_MCP_TOOL_UNDECLARED`, and MCP refuses to boot | an action or query written out in `defineAppMcp`'s `actions:`/`queries:` never declared `mcp: { expose: true }` — a boot-time configuration error, not a hidden tool | add `mcp: { expose: true, description: '<what it does>' }` beside the primitive's policy, or drop it from the list and let `include: 'exposed'` project what opted in |
| `X_MCP_SCOPE_UNKNOWN`, and MCP refuses to boot | `defineAppMcp`'s `scopes:` map names a tool by a name the server does not project — a typo, or the primitive was renamed or dropped from `actions:`/`queries:`/`tools:` | spell the name as one of the tools the server actually projects, or drop it from that `scopes` entry |
| `X_MCP_SCOPE_DENIED` | the connection's token does not carry the tool's scope — scope is a property of the token, not of the actor's permissions | reconnect with a token whose scopes include the one `cause` names — the app's `resolveToken(token)` returns them — or drop that scope from `defineAppMcp({ scopes })`. Scopes are fixed for the life of a connection, so a grant takes effect on the next one. `x token grant` is **planned** and exits `X_NOT_IMPLEMENTED` |
| `X_FORBIDDEN` from a `tools/call` | the tool was invoked and its policy refused this input — the same denial the HTTP route returns for the same call | grant the human the permission — an agent can never exceed the human it acts for |
| Dev MCP server not reachable | `x dev` not running, or you pointed at prod | default socket is `mcp.devSocket` (`ws://localhost:9229`). The dev server is **never** bound in `ROLE=web` |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given exactly one read-only statement | send a single **read-only** `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — a data-modifying CTE is not a read. MCP has no arbitrary-write path: change data by calling an action exposed with `mcp: { expose: true }`, change schema with `db.migrate` on a branch database |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` was aimed at a database that is not a branch | `x db branch <name>`, then retry `db.migrate` |
| `X_LLM_OUTPUT_INVALID` | structured output failed its schema twice | tighten the prompt or loosen the schema; the retry already happened once |
| Prompt change had no effect | semantic cache hit | bump the prompt version — editing a prompt requires it. (`x ai cache --json` is **planned**; `x test eval --json` is the shipped command) |
| `x verify` fails on a prompt | no evals file | an unevaluated prompt is untested code. Add `<prompt>.evals.ts` |

## Still stuck

```
x verify --json > verify.json
x doctor --json > doctor.json
```

Open an issue with both files attached, plus your Bun version, your `@ultimat3/*` pin, and the `x errors explain <CODE> --json` output for any code you hit. Security issues go through [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue.

Code index: [Error codes](Error-Codes). Config fields: [Configuration](Configuration). Upgrade failures: [Upgrading](Upgrading).
