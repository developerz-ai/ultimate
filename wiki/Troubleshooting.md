# Troubleshooting

Symptom → cause → fix. Every `X_*` error already carries its own cause and exact fix command; this page is for symptoms that do not start with a code.

## Triage

Run these first, in this order. All support `--json`.

| Command | Answers |
|---|---|
| `x doctor --json` | Bun version, env schema, DB/transport/storage reachability, port conflicts |
| `x verify --json` | the gate: typecheck, lint, boundaries, six test types, drift, contract diff, budgets, SEO + i18n, manifest freshness |
| `x errors explain <CODE> --json` | cause, fix command, docs URL for any `X_*` code |
| `x status --json` | roles up, build IDs, client build-ID distribution, queue depth, socket counts |
| `x logs tail --json` | structured logs + OTel spans, filterable by role, trace, or code |

The `--json` form is the same content as the terminal form. Paste the JSON into a bug report; do not paraphrase the terminal.

## Boot and env

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits in ~40ms, `X_ENV_MISSING` | a key in the `env` schema is not set in this environment | set the key; `x doctor --json` lists every missing one at once |
| `X_ENV_INVALID` | key present but fails its schema (short secret, non-URL, bad enum) | the cause names the key and the constraint; fix the value |
| `X_CONFIG_INVALID` at load | `app.config.ts` field invalid — `defaultLocale` not in `locales`, `db.pool < 1`, non-IANA `timeZone`, `realtime.transport` set without `realtime.url` | `x config show --json`, then edit the field named in `cause` |
| `X_ROLE_INVALID` | `ROLE` is not one of `web sync worker scheduler migrate replicator all` | fix the env var on that service |
| `X_BUN_VERSION` | below the Bun 1.3 floor | upgrade Bun |
| Container starts then loops | `/readyz` failing, not `/healthz` — usually DB unreachable or a migration version mismatch | `curl /readyz` and read `checks[]`; it names the failing check |
| Config edits have no effect | you edited a per-environment file that does not exist — config is **one file** | put the difference in an env var ([Configuration](Configuration)) |

## Database

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations (a column added by hand, or a generated migration never applied) | `x db gen "<message>"` then `x db apply` |
| `X_MIGRATE_CONCURRENT` | another version's `ROLE=migrate` holds the advisory lock | wait for it to exit 0; never run two deploys' migrations at once |
| `ROLE=migrate` exits non-zero, deploy blocked | migration failure — correct, the roll is supposed to stop | read the SQL error, fix the migration, re-run. Do not start `web` on the old schema |
| `X_TIMEOUT` on one query | past `db.statementTimeout` (default `'10s'`) | add the index the plan wants, or narrow the query. Raising the timeout hides it |
| Connection exhaustion under load | `db.pool` × replicas × roles exceeds Postgres `max_connections` | lower `db.pool`, or a pooler in front. `x status --json` reports per-role pool use |
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
| `X_BUDGET_EXCEEDED` on `js` | one import pulled a library into a surface | the error names the **import chain**; `x budgets report --json` for per-route detail |
| A `site/` route reports non-zero JS | a component with client state leaked into the static surface | move it to `app/`, or set `hydrate: 'never'` |
| LCP or CLS regression | an unsized image or a late-loading font | `x budgets report --json`; images go through the pipeline, never a raw `<img>` |
| `X_SEO_NO_TITLE` / `X_SEO_NO_DESCRIPTION` | `meta` missing a field, or a description outside 50–160 chars | add it to the route's `meta`. Deleting a description is a build error, by design |
| `X_ROUTE_META_MISSING` | a route has no `meta` at all | every route sets `render`, `offline`, `hydrate`, `meta` |
| `X_CATALOG_MISSING_KEYS` | a key exists in one locale's catalog and not another | the cause lists key + locale; add the translation. There is no silent English fallback |
| `⟦some.key⟧` rendered in the UI | the key is missing everywhere | add it to the default catalog; `x verify` fails until you do |
| Lighthouse gate fails | below `seo.lighthouse.seo` (100) or `accessibility` (95) | fix the audit, don't lower the threshold |

## Jobs

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_JOB_NO_IDEMPOTENCY_KEY` (compile error) | `idempotencyKey` omitted — it is required by the type | add an `idempotencyKey` derived from `input` only, e.g. `onboard:${orgId}` |
| `X_JOB_DUPLICATE_STEP` | two `step.run` calls with the same name in one `run` | rename one. Step names must be unique and stable |
| A step re-ran after a deploy | the step was **renamed** — renaming invalidates its stored result | treat a rename as a new step; keep old names |
| `X_IDEMPOTENCY_CONFLICT` | same key, different input, inside the dedupe window | the key is not deterministic from `input`. Remove the timestamp or random part |
| Job stuck "in-flight" after a worker was killed | the lease has not expired yet | wait `jobs.visibilityTimeout` (default `'30s'`); the row is re-claimed and resumes at the **next** step, never mid-step. `x jobs show <id> --json` |
| Job in dead-letter | `retry.attempts` exhausted | `x jobs show <id> --json` for the step trace, then `x jobs retry <id>` — it replays from the failed step |
| Nothing is processing | no `worker` for that queue name | check `WORKER_QUEUES` against `jobs.queues` |
| A job ran but the row it needs doesn't exist | enqueued outside the transaction | enqueue via `<job>.enqueue` inside the action's `handle`; `X_OUTBOX_NO_TX` catches the rest |
| Cron never fires | no `scheduler`, or the standby is holding | `scheduler` is fixed at 1 active; a standby reports not-ready by design. `x status --json` |

## Realtime

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_TRANSPORT_UNAVAILABLE` | fanout bus unreachable, or `realtime.transport` is not `memory` with no URL set | `x doctor transport`; set `REALTIME_TRANSPORT_URL` |
| Live query rejected at build | unbounded — missing `orderBy` or `limit` | add both. An unbounded result has no bounded change buffer and no bounded reconnect snapshot |
| Live query rejected for non-determinism | `now()` / `random()` in the `sql` | move it to `input`; the same `(input, row)` must always yield the same membership answer |
| `X_SUBSCRIPTION_LIMIT` | a socket or tenant hit its cap | raise `realtime.limits.perSocket`, or unsubscribe unused live queries |
| `X_LIVE_QUERY_LIMIT` | too many distinct live queries per tenant | raise `realtime.limits.perTenantQueries`, or narrow the query set |
| `X_CURSOR_STALE` | resume cursor outside the change buffer window | widen `realtime.changeBuffer`, or pass `'snapshot'` to `resumeFrom()` so the fallback re-snapshots |
| `X_TOPIC_FORBIDDEN` | tier-1 topic guard denied the actor | fix the topic scope; the cause names actor + topic, never the topic's data |
| Reconnect storm after a deploy | drain was truncated by SIGKILL, so no `reconnect` frame was sent | set `stop_grace_period` / `terminationGracePeriodSeconds` >= `DRAIN_TIMEOUT` ([Deployment](Deployment)) |
| Reconnects still spiky with a clean drain | `realtime.drain.window` pinned too small | use `'auto'` — the server sizes the jitter window from live connection count |
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
| Preview build poisoned a cache | impossible via the framework — build ID scopes the SW cache namespace and scope | confirm the branch build ID in `x status --json` |

## Tests

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_EGRESS` | a test reached the network unmocked | the error names the URL. Mock it — sealed network is the design, not a bug |
| A test passes alone, fails in the suite | shared state that should not exist — each worker gets its own cloned DB | check for a module-level singleton or a fixture written outside `seed()` |
| Time-dependent failure | asserted on wall clock | use the frozen clock and `clock.advance('3d')` — it also drives `step.sleep` and cron |
| A test flakes | **fix it or delete it the same day** | there is no `retry: 3`. A test that passes twice and fails the third trains people to ignore red |
| Snapshot/UUID churn between runs | not using `seed(name)` | seeds are deterministic: same input → identical rows, identical UUIDs |
| Job test doesn't drain | queue not advanced | `await runJobs.drain()`; workers run deterministically in tests |
| `--keep-db` needed | inspecting a failure | `x test <type> --keep-db`, then connect to `myapp_test_N` |

## MCP and AI

| Symptom | Likely cause | Fix |
|---|---|---|
| `X_MCP_TOOL_UNKNOWN`, or a tool absent from `tools/list` | the tool is hidden from this caller, or the name is stale — role-hidden and absent answer identically, on purpose | visibility is fail-closed: check the caller against the tool's `visibleTo` (a role allowlist or a predicate over the caller). Otherwise `tools/list` for the catalog this caller may use, and `x manifest` if the committed manifest is stale |
| `X_MCP_TOOL_UNDECLARED`, and MCP refuses to boot | an action or query written out in `defineAppMcp`'s `actions:`/`queries:` never declared `mcp: { expose: true }` — a boot-time configuration error, not a hidden tool | add `mcp: { expose: true, description: '<what it does>' }` beside the primitive's policy, or drop it from the list and let `include: 'exposed'` project what opted in |
| `X_MCP_SCOPE_DENIED` | the connection's token does not carry the tool's scope — scope is a property of the token, not of the actor's permissions | `x token grant <scope>`, then reconnect: scopes are fixed for the life of a connection |
| `X_POLICY_DENIED` from a `tools/call` | the tool was invoked and its policy refused this input — the same denial the HTTP route returns for the same call | grant the human the permission — an agent can never exceed the human it acts for |
| Dev MCP server not reachable | `x dev` not running, or you pointed at prod | default socket is `mcp.devSocket` (`ws://localhost:9229`). The dev server is **never** bound in `ROLE=web` |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given exactly one read-only statement | send a single **read-only** `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — a data-modifying CTE is not a read. MCP has no arbitrary-write path: change data by calling an action exposed with `mcp: { expose: true }`, change schema with `db.migrate` on a branch database |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` was aimed at a database that is not a branch | `x db branch <name>`, then retry `db.migrate` |
| `X_LLM_OUTPUT_INVALID` | structured output failed its schema twice | tighten the prompt or loosen the schema; the retry already happened once |
| Prompt change had no effect | semantic cache hit | bump the prompt version — editing a prompt requires it. `x ai cache --json` |
| `x verify` fails on a prompt | no evals file | an unevaluated prompt is untested code. Add `<prompt>.evals.ts` |

## Still stuck

```
x verify --json > verify.json
x status --json > status.json
```

Open an issue with both files attached, plus your Bun version, your `@ultimat3/*` pin, and the `x errors explain <CODE> --json` output for any code you hit. Security issues go through [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue.

Code index: [Error codes](Error-Codes). Config fields: [Configuration](Configuration). Upgrade failures: [Upgrading](Upgrading).
