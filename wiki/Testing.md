# Testing

`bun test`. N workers, N real Postgres databases, sealed network. No mocking the database, no rollback hacks, no shared-state flakes.

Tests live next to their source as `<file>.test.ts`.

## Parallel by database clone

```
bun test --workers 8
  worker 0 → myapp_test_0   (CREATE DATABASE myapp_test_0 TEMPLATE myapp_test_tpl)
  worker 1 → myapp_test_1
  ...
```

| Step | Mechanism |
|---|---|
| Once per run | build a template DB: migrate + seed → `myapp_test_tpl` |
| Per worker | `CREATE DATABASE myapp_test_N TEMPLATE myapp_test_tpl` — Postgres file-copies, typically 100–400ms |
| Per test file | truncate the tables that file touched, or take a savepoint if it declares `readonly` |
| Teardown | drop on exit; `--keep-db` to inspect a failure |

### Rejected approaches

| Common approach | Why rejected |
|---|---|
| Wrap each test in a transaction and roll back | breaks anything that commits: the outbox, `LISTEN/NOTIFY`, logical replication, real isolation levels, nested transactions, and every job test. You end up testing a code path production never runs |
| One shared test DB with serial tests | slow, and the first flake teaches everyone to re-run instead of read |
| One shared DB with parallel tests | shared-state flakes. The failures are order-dependent, unreproducible, and eventually the suite is ignored |
| Mock the database | tests pass, SQL is wrong. The main thing worth testing is the query |

Real databases, truly parallel, is the only combination that is both fast and honest.

## Determinism

Any test that can pass twice and fail the third time is worse than no test — it trains people to ignore red.

| Control | Behavior |
|---|---|
| **Seeds** | `seed(name)` builds a named, deterministic fixture graph via entity factories. Same input → identical rows, identical UUIDs |
| **Frozen clock** | time starts at a fixed instant. `clock.advance('3d')` moves it, and it also drives `step.sleep` and cron in tests |
| **Seeded RNG** | `Math.random`, `crypto.randomUUID`, and Bun's RNG are seeded per test file from its path — reproducible, distinct across files |
| **Sealed network** | a `fetch`, a `new WebSocket(…)` or a `Bun.connect(…)` to anywhere not explicitly mocked or allowed **fails the test** with `X_TEST_NETWORK_SEALED`, naming the URL and the fix — the three dials share one gate, so the allow-list and `offline()` apply to all of them — `offline()` refuses a loopback dial too (`X_TEST_NETWORK_OFFLINE`). A dial that goes around those three globals (a `node:net` socket, `Bun.udpSocket`) is not sealed |
| **Fixed timezone + locale** | `UTC` and `en-US` unless a test declares otherwise; a tz-dependent bug fails deterministically |
| **Ordered concurrency** | job workers in tests run deterministically; `runJobs()` drains the queue synchronously |
| **Per-test reset** | before EVERY test, not every file, the preload puts the jobs event bus back (`installPerTestReset()`): an answer one test published never resumes the next test's waiting run, with or without `runJobs`. A test that never loaded `@ultimat3/jobs` pays nothing. `As of 2026-10` |
| **Seal key** | a test over a `.sealed()` column needs no key: the preload sets `ULTIMATE_SECRETS_KEY` to a fixed throwaway when `NODE_ENV=test` and the app has neither the variable nor `.secrets.key`. The app's own key wins. `startE2eApp` hands the same key to the app it spawns. The key is public — it ships in the package — and is installed nowhere else, `As of 2026-10` |

Sealed network is the highest-value rule: it converts "the suite is slow and occasionally fails" into "you forgot to mock Stripe, here is the line".

```
X_TEST_NETWORK_SEALED: unmocked network call
  cause: POST https://api.stripe.com/v1/charges from app/billing/service.ts:42
  fix:   mockFetch('https://api.stripe.com/v1/charges', () => new Response('{}')) — or allowHost('api.stripe.com') if it must be real
```

Locale and zone are declared per test when the behavior under test depends on them — see [Timezones and dates](Timezones-And-Dates) and [I18n](I18n).

## The six test types

| Type | Command | Asserts | Runs against |
|---|---|---|---|
| **unit** | `x test unit` | pure logic — services, money, policy predicates, matchers | no DB, no I/O |
| **contract** | `x test contract` | an action's input/output schema, its policy denials, its emitted OpenAPI + MCP tool shape | cloned DB |
| **live** | `x test live` | a live query's initial snapshot, incremental patches on write, reconnect delta, and that a policy-failing row is never delivered | cloned DB + in-process replicator + in-process NATS |
| **job** | `x test job` | step-level replay (a step already run is not re-run), idempotency-key dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback | cloned DB + frozen clock |
| **e2e** | `x test e2e` | a real browser (Chrome over raw CDP, no Playwright) against the app: render mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload, two tabs, offline writes | the app spawned on a throwaway database (`ULTIMATE_STATE_DIR`) + a real browser, when Chrome is present |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

**Each helper takes `{ timeoutMs }`** — `unitTest(name, body, { timeoutMs: 30_000 })`, the same
on `contractTest`, `liveTest`, `jobTest`, `e2eTest` and `test`, and a key of `evalTest`'s options.
Handed to `bun:test`; absent is Bun's 5 s default. Never `test(testName('unit', …), body, 30_000)`
to buy a deadline.

**`unitTest`, `contractTest`, `liveTest` and `jobTest` take [the fixture bag](#the-fixture-bag)**,
exactly as `test` does: `unitTest('…', async ({ runJobs, clock }) => …)`. A body that destructures
nothing builds nothing. Never `describe(testName('unit', …))` around a bare `test` to reach a
fixture. `As of 2026-10`.

**The e2e step drives a real browser, `As of 2026-09-22`** (21.0.0). When Chrome is on the
machine, `x verify`'s `e2e` step spawns the app with `startE2eApp` (reset, seed, boot, on its own
throwaway `ULTIMATE_STATE_DIR`) and runs the suite with a real `page`
(`packages/cli/src/verify-e2e.ts`). **Before this, the reference app's e2e suite ran with no
browser at all**, and its browser-backed cases skipped under a green gate; this page described
them as running. The session API (`openE2eBrowser()`, `cdpE2eSession`) can open a second tab in the
same profile (`newTab`) and add an init script. It can take the page offline, workers included,
and set cookies. It lists the page's sockets and requests, reads IndexedDB database names, and
waits for an expression (`waitFor`). That is what the two-tab and offline cases rest on. The spawned
app runs with `APP_URL` set to its own origin, `NODE_ENV` stripped and `ULTIMATE_ENV=development`:
a `NODE_ENV=test` inherited from `bun test` made it resolve as `test`, and a missing `APP_URL`
answered 500 with `X_ENV_MISSING`. Readiness is polled over `node:http`, because the e2e preload
seals `fetch` against egress. Each e2e test gets 60 s (`E2E_TEST_TIMEOUT_MS`). A spawned app
that will not come up is `X_E2E_APP_FAILED`.

| Fixture or call | What it is |
|---|---|
| `e2eApp()` | the spawned app: `{ base, stateDir, stop(), restart(env?) }` |
| `deploy.newBuild()` | restarts the app with a new `BUILD_ID`, so a version-skew test sees a real deploy. Registered only when the runner can restart the app (`installE2eDriver({ newBuild })`); refused by name otherwise. `x dev` honours a set `BUILD_ID` for this |
| the liveness probe | between tests the preload asks the browser to answer (`answersWithin`) and relaunches one that stopped, so one crashed tab fails one test, not the rest of the suite |

Each type is a first-class runner with its own fixture shape — not a naming convention on top of one runner. Every command supports `--json`.

### Evals

An eval declares its cases beside the prompt (`<name>.evals.ts`) and gates on the **drop** from a
committed baseline, never on an absolute score — models drift, prompts should not.

| Rule | Code |
|---|---|
| a prompt no `defineEval` names | `X_EVAL_MISSING` |
| the run mean or a case fell past `tolerance` | `X_EVAL_THRESHOLD` |
| the baseline was never recorded | `X_EVAL_BASELINE_MISSING` |

```ts
export const summarizeEval = defineEval({
  name: 'summarize',
  prompt: summarizePrompt,
  cases: [{ name: 'refund', vars: { ticket: 'I want my money back' }, expected: 'billing' }],
  scorers: [exact, jsonSchemaValid(['category', 'summary'])],
  baseline: import.meta.resolve('./summarize.baseline.json'),
  tolerance: 0.05,
});
```

`ULTIMATE_EVAL_RECORD=1 x test eval` re-records every baseline, so accepting a new number is a
reviewable diff instead of an edited threshold. It is refused inside the gate: `x verify` with that
variable set is `X_EVAL_RECORDING` and runs no eval suite, because recording passes by definition
and would overwrite the committed baselines during the run.

```ts
// contract test — generated as a scaffold with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_FORBIDDEN');
});
```

```ts
// job test — the step guarantee, not the happy path
test('onboardOrg retries only the failed step', async ({ seed, clock, mail }) => {
  const { org } = await seed('fresh-org');
  mail.failOnce(nudgeEmail);
  await runJobs(onboardOrg, { orgId: org.id });
  clock.advance('3d');
  const trace = await runJobs.drain();
  expect(trace.steps.provision.executions).toBe(1);       // replayed from storage
  expect(trace.steps['nudge'].executions).toBe(2);        // only this one retried
});
```

The `job` example is the one that matters: it asserts the durability guarantee, not that mail was sent. See [Jobs and workflows](Jobs-And-Workflows) and [Policies and authz](Policies-And-Authz).

## Matchers

Installed by the preload on `expect`.

| Matcher | Asserts |
|---|---|
| `toBeUltimateError(code?)` | an `X_` code with a cause and a fix; the code when given |
| `toDenyPolicy(context)` | the policy refuses that context |
| `toEmitSteps(names)` | a job runs exactly those steps, in order |
| `toMatchOpenApi(committed)` | no operation removed, no parameter newly required |
| `toBeWithinBudget(limit)` | a measured number is at or under the limit |
| `toRejectInput(input)` / `toAcceptInput(input)` | a schema's verdict on one input |
| `toEqualRow(expected)` | equality over every OWN property — the one that sees a `.sealed()` column |
| `toBeVisible(options?)` | waits for a locator to show; `.not` waits for it to go |

`toEqualRow` exists because `toEqual` walks enumerable properties and a repository row does not
enumerate a sealed column ([Sealed columns](Entities-And-Migrations#sealed-columns)):

```ts
const row = await db.connections.insert({ label: 'primary', password: 'hunter2' });

expect(row).toEqual({ id: row.id, label: 'primary', password: 'hunter2' });    // fails, empty diff
expect(row).toEqualRow({ id: row.id, label: 'primary', password: 'hunter2' }); // passes
```

A failure names each property that differs. A server-only one is named and never printed — not its
value, not its length.

## Rendering a page in a unit test

No server, no browser, no cast. `renderRoute` takes the route module whole and resolves it the way
a request does; `renderView` renders one component with its own props.

```ts
import { expect, renderRoute, renderView, unitTest } from '@ultimat3/testing';
import * as page from './page';

unitTest('the dashboard counts the posts of the org that is looking', async () => {
  const view = await renderRoute(page, { url: 'https://example.test/dashboard', actor: viewer });
  expect(view.data.rows).toHaveLength(2);
  expect(view.meta.title).toBe(t('app.dashboard.title'));
  expect(view.text).toContain(t('app.dashboard.tableTitle'));
  expect(view.islands.map((island) => island.moduleId)).toEqual(['shared-theme-toggle']);
});
```

| Answer | Is |
|---|---|
| `view.html` | the markup, as the document carries it |
| `view.text` | what a reader sees — tags and script/style bodies removed, entities decoded. Compare it with `t('<key>')` |
| `view.data` · `view.meta` | what `load` resolved, and what `meta` answered for that same object |
| `view.islands` | the islands the render emitted. Empty on a page that ships no JavaScript |

`actor` runs `load` and the page inside a request context holding that actor. `renderView` refuses
a component that renders an `island()` — its hydration timing is a route's. `As of 2026-10`.

## Running a mutator's local half

```ts
const store = memoryLocalTx({ posts: { [id]: { id, title: 'before', pending: false } } });
renamePost.local(store.tx, { id, orgId, title: 'after' });
expect(store.rows('posts')).toEqual({ [id]: { id, title: 'after', pending: true } });
```

`memoryLocalTx(seed?)` is the client store under test: keyed rows, `update` a no-op for a key it
does not hold, `undefined` leaving a column alone, rows frozen. Apply `local` twice and compare —
a rebase replays it. `As of 2026-10`.

## Seeing what you built

An assertion says a component behaved. It does not say what it looked like while it did. `x shot`
is the other half: a real browser, a PNG, and a `verdict.json` that says whether the picture is of
what you think it is.

```bash
x shot /dashboard --json              # one route
x shot --island post-form --json      # one island, every state it declares, both themes
x shot --island post-form --state refused --json
x shot --all-islands --json           # every island in the app, plus an index
```

**`x shot` is deliberately not a step of `x verify`.** It needs a real browser, and a gate that
goes red because a machine has no Chrome fails for reasons unrelated to the change. `x shot`
launches Chrome itself over raw CDP — no browser library in the app. It takes the first of
`--browser`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, then a probe of the usual install paths; or
it attaches to a running browser with `--cdp-url` (or `SCRAPE_CDP_URL`). No browser at all is
`X_SHOT_BROWSER_MISSING`, raised before the dev server boots: `export CHROME_PATH=<binary>`.

`As of 2026-09-23`.

### States are declared, not clicked

A state a running app will not produce on request — a save the server refused, a read that came
back empty, a label three times as long in the next locale — is unreachable to a reviewer and to a
model. Declare it instead, in a `<name>.island.states.ts` beside the island:

```ts
import { defineIslandStates } from '@ultimat3/testing';

export const postFormStates = defineIslandStates({
  island: 'apps/web/app/post/post-form.island.tsx',
  states: [
    { id: 'idle', title: 'the first paint', props: {} },
    {
      id: 'refused',
      title: 'the server refused the save',
      note: 'unreachable by clicking — the action only fails for an actor without the capability',
      props: { error: 'You cannot publish in this org.' },
    },
    {
      id: 'slow',
      title: 'the save is in flight',
      note: 'a request that never settles; a real one resolves faster than a screenshot',
      props: {},
      routes: [{ match: 'POST /api/post', respond: { kind: 'pending' } }],
    },
  ],
});
```

| Field | Is |
|---|---|
| `island` | app-root-relative path of the `.island.tsx` these belong to |
| `states[].id` | a slug. It becomes the filename stem, so it is guessable or it is nothing |
| `states[].title` | one line: what this state **is** |
| `states[].note` | why it deserves a picture — usually "you cannot reach this by clicking, because …" |
| `states[].props` | JSON, riding the same `data-x-props` seam hydration already uses |
| `states[].routes` | stubs for whatever the component fetches: `{ kind: 'json', status?, body }`, `{ kind: 'pending' }` or `{ kind: 'offline' }`, matched as a `"<METHOD> <pathname>"` prefix |
| `states[].viewport` · `themes` | per state. Both themes unless the state is only meaningful in one |
| `viewport` · `target` · `timeZone` · `now` | manifest-wide. `1280x800`, the island's host element, `UTC`, and the suite's frozen instant |

Rules the file is held to:

| Rule | Refused by |
|---|---|
| pure data — no sibling import, no framework import, no Solid | `X_TEST_ISLAND_STATES_NOT_PURE`, read off the text at load: a module importing Solid evaluates fine under Bun, so no amount of loading it would notice |
| the manifest declares at least one state | `X_TEST_ISLAND_STATES_EMPTY` |
| a state id is a slug, unique within the manifest | `X_TEST_ISLAND_STATE_ID_INVALID` · `X_TEST_ISLAND_STATE_DUPLICATE` |
| `props` are JSON | `X_TEST_ISLAND_STATE_JSON_INVALID` |
| a route stub matches `"<METHOD> <pathname>"` | `X_TEST_ISLAND_STATE_STUB_INVALID` |
| `timeZone` is an IANA name and `now` carries an explicit offset | `X_TEST_ISLAND_STATE_CLOCK_INVALID` — one code for both |
| every island has one | `guards/island-without-states.ts`, in `x verify`'s `boundaries` step |

`x g island <name>` and `x g resource <name>` write the states file with the island — two states,
one of them a translation three times as long. You are editing a generated file, never creating one.

### The index is the artifact

A run writes `.x/shot/island/index.md` — one Markdown file an agent opens instead of guessing at
forty PNGs. Written for a single-island run too: the file that says what a picture **is** cannot be
a property of how many islands you asked for.

| Per | The index states |
|---|---|
| run | islands, states and pictures counted; the three commands that reproduce it; what the capture cannot see |
| island | its name, its source path, and `ok` or `FAILED` |
| state | the id, the title, the `note`, one picture path per theme, and a verdict |
| a failure | its reasons, listed rather than collapsed — `no picture (dark)`, `never mounted (light)`, `2 requests no stub answers`, `1 uncaught exception`, `3 console errors` |
| a note | recorded and **not** gating — console warnings, and content overflowing the crop target |

Pictures land at `.x/shot/island/<name>/<state>-<theme>.png`. Flat and mechanical, because the
reader guesses the path.

The blind spots are in the artifact rather than in this page: the picture is the crop target and a
thin margin, so a component's own fault sitting further out is outside the frame, and a
`toLocaleString()` on a `Date` resolves its zone inside the engine where only an explicit
`timeZone` is pinned. The index prints both under "What this capture cannot see".

What the rendered result is then held to: [Interface rules](Interface-Rules).

## The fixture bag

`test` and the typed helpers pass a bag as the first argument and build only what the body destructures — a test that never names `runJobs` never starts a queue. The framework owns the whole bag; an app registers only what the framework cannot know.

| Fixture | Is | Built by |
|---|---|---|
| `clock` | `now()` · `advance('3d')` · `set(instant)` | the preload |
| `mail` | `outbox()` · `lastTo(address)` · `failOnce(mail)` | the preload |
| `network` | `offline()` · `drop()` · `online()` · `state()` | the preload |
| `runJobs` | enqueue+drain, then `enqueue()` `drain()` `due()` `inFlight()` `depth()` → [A job under `runJobs`](#a-job-under-runjobs) | the preload |
| `statements` | `all()` · `count(fingerprint?)` · `shapes()` — and an N+1 fails the test | the preload |
| `page` | `goto` · `gotoStreamed` · `getByRole` · `evaluate` · `waitForServiceWorker` | a browser driver |
| `budget` | `jsBytes(route)` off the built output | a browser driver |
| `signIn` | put the browser session in a member's shoes | a browser driver |
| `deploy` | `newBuild()` — same app, new build id, page still open | a browser driver |
| `subscribe` | one subscriber's `rows()` `patches()` `settled()` `lsn()` | a replicator |
| `seed`, and anything else | the app's own graph | the app's `scripts/test-setup.ts` |

The last five are **declared, not built**. The framework does not bundle a browser, so the name resolves and asking for it without a driver fails as `X_TEST_FIXTURE_UNAVAILABLE` naming what is missing — different from `X_TEST_FIXTURE_UNKNOWN`, whose fix ("register it") would have the app inventing its own idea of what a page is. A driver installs through the same registry:

```ts
// scripts/test-setup.ts
defineFixtures({ page: () => openBrowserPage(), seed: () => loadSeed });
```

`defineFixtures` merges and the last registration wins, so a driver replaces the declaration it was waiting on. There is no second seam.

`network.offline()` fails every request ahead of the mocks, so the app's own offline path runs instead of a branch written for the test; `drop()` is the same for a request but tells a subscriber its connection was cut rather than closed, which is what separates a resume from a resubscribe.

## A job under `runJobs`

```ts
unitTest('a row deleted before the run is skipped, not failed', async ({ runJobs }) => {
  const trace = await runJobs(reindexPost, { id, orgId });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toEqual({ skipped: true });
  expect(Object.keys(trace.steps)).toEqual(['load']);
});
```

| On the trace or the call | Is |
|---|---|
| `trace.executions[n].result` | what the body returned. Absent on a run that failed, suspended or was interrupted |
| `trace.steps[name].executions` | times the step body ran — a replay from storage does not count. Cumulative for the test |
| `runJobs(job, input, { actor })` · `drain({ actor })` | the identity the **worker** runs as (`WorkerOptions.context()` in a real one). Its org is still the job's declared `tenant`; `tenant: 'none'` strips it. Absent is the anonymous actor |
| `runJobs(job, input, { tenantId })` · `enqueue(…, { tenantId })` | the **enqueuer's** tenant on the row: the limiter's bucket and the dedupe namespace, as `handle.as(actor, input)` files it. One key in two tenants is two jobs |
| the event bus | fresh per fixture: one test's `publishEvent` never resumes the next test's `step.waitForEvent` |

Enforced through it, keyed or not: `concurrency` and `whenBusy` — each pass is a real worker's `tick()`, so a run over its slot waits for the next pass, or is refused under `whenBusy: 'fail'`. The lease is renewed on the test clock — every millisecond of it — so a body in flight learns of a cancel at the next `clock.advance()`: cancel, `clock.advance(1)`, await the drain. A `clock.advance()` past the visibility timeout while it runs is `X_JOB_LEASE_LOST`, as in production. `As of 2026-10`.

## Testing an island

One block per state the island's manifest declares. `describeIslandState` owns the lookup, the
mount (`beforeAll`, 60 s unless `timeoutMs` says otherwise) and the teardown; the island is built
once per file.

```ts
const island = { build: buildIslands, root: join(import.meta.dir, '..', '..', '..') };

describeIslandState(counterStates, 'idle', island, (mounted) => {
  test('a click reaches the DOM through the signal', () => {
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(mounted().text('[data-role="count"]')).toBe('1');
  });
});
```

| | |
|---|---|
| `mounted()` | the block's mount — an accessor, because the block is declared before `beforeAll` runs |
| `shell` · `globals` · `size` | per block: the server's markup inside the wrapper, a `fetch` stub, the host's box |
| an id the manifest does not declare | `X_TEST_ISLAND_STATE_UNKNOWN`, listing the declared ones |
| `mountIslandState(manifest, id, options)` | the same lookup for one test's own mount: `using island = await mountIslandState(…)` |

The props are the manifest's, so the picture `x shot --island` takes and the test are of one
component. `mountIsland` stays the call for props no state declares. `As of 2026-10`.

## Testing an authenticator

```ts
unitTest('a session cookie resolves the member it was issued to', async () => {
  const actor = await authenticate(...(await authRequest({ cookies: { session: token } })));
  expect(actor?.id).toBe(member.id);
});
```

`authRequest({ url?, method?, headers?, cookies?, bearer? })` answers the two arguments
`configureAuthenticator()`'s function is handed — a real request over a real context, no server,
no cast. `cookies` and `bearer` win over the same header spelled in `headers`. `As of 2026-10`.

## Log lines under test

| `LOG_LEVEL` | The terminal shows | A `setLogSink` a test installs receives |
|---|---|---|
| unset | nothing | `info` and above |
| `info` · `debug` · `trace` | that level and above | that level and above |
| `warn` · `error` · `fatal` · `silent` | that level and above | `info` and above, still |

`LOG_LEVEL=info bun test <file>` is how to read the lines. A level above `info` filters the
terminal and never the logger, so a test asserting on an `info` audit line passes under
`LOG_LEVEL=error`. `As of 2026-10`.

## An N+1 fails the test it happened in

`x dev` warns about a query loop; CI is where nobody is watching. Destructuring `statements` installs the same detector in **throw** mode for the length of one test:

```ts
test('the feed reads its authors once', async ({ statements }) => {
  await renderFeed();
  //   X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
  //   fix: db.posts.preload('author')   # one statement for the whole page
  expect(statements.count('posts.findMany')).toBe(1);
});
```

The loop's fifth statement is what rejects, so the failing line is the loop's own — not a summary at teardown. Opting in is naming the fixture: there is no `strict: true` to remember and no switch left on for the next file.

| What | Rule |
|---|---|
| **The unit of work is the test** | not the request. A `posts.findById(id)` loop in a unit test has no request anywhere, and that is the loop worth catching |
| **The threshold is the dev one** | 5 statements of one shape, `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity`. A loop that fails a test and a loop that warns in `x dev` are the same loop |
| **The fix is the schema's** | the same `nPlusOne()` error `x dev` renders, so the `fix:` names the `preload()` your `references()` columns already spell |
| **Once per shape** | a body that catches the error gets one failure, not one per statement after it — and `shapes()` still reports the whole loop |
| **Measurement is not the verdict** | `all()`, `count()` and `shapes()` count every statement, including ones inside `expectedQueryLoop`; only the verdict honours the suppression |

A deliberate loop is declared where it is written, never silenced at the test:

```ts
await expectedQueryLoop('one indexed lookup per searchable field', () => searchEachField(term));
```

## Factories

One row shape per entity, deterministic, with named variations. `defineFactory` is the only entry point — there is no bare `factory()`.

```ts
import { associate, defineFactory } from '@ultimat3/testing';

const orgFactory = defineFactory(org, {
  defaults: (index, ids) => ({ id: ids.uuid(), name: `org-${index}` }),
});

const postFactory = defineFactory(post, {
  defaults: (index, ids) => ({ id: ids.uuid(), title: `post-${index}`, published: false, views: 0 }),
  traits: {
    published: { published: true },
    popular: (index) => ({ views: index * 100 }),
  },
  associations: { orgId: associate(orgFactory, (row) => row.id) },
});
```

| Member | Does |
|---|---|
| `build(over?)` | an in-memory row. Pure — no database, no persister |
| `buildMany(count, over?)` | the same, `count` times |
| `create(over?)` | builds, creates its association parents, then persists. Returns the row |
| `createMany(count, over?)` | the same, `count` times |
| `with(...traits)` | a view with those traits applied |
| `traits` | the declared trait names, sorted |
| `table` | the entity's table |
| `reset()` | restarts the sequence and both generators, and **cascades to every association** |

### Traits

A trait is a `Partial<Row>` or a `(index, ids) => Partial<Row>`. Merge order is: defaults, then traits in the order applied, then the call's own `over` — last wins.

A view from `with()` **shares the base sequence**, so ids never repeat across views of one factory. An unknown trait throws `X_TEST_FACTORY_TRAIT_UNKNOWN` **at the `with()` call**, not three calls later, and `cause` lists every declared trait — a typo and a trait nobody added have the same symptom, and the list is what separates them.

### Associations

A column whose value comes from another factory, built with the **same strategy**: `build()` builds the parent, `create()` creates it. Parents are created **sequentially, never `Promise.all`** — concurrent parents would interleave draws from the shared seeded generators and the ids would stop being reproducible. An association is skipped entirely when the caller supplies that column.

### Determinism

`seed` defaults to a hash of the **table name**, so every table has its own uuid stream while staying a pure function of the schema. `As of 2026-08` that is the 1.1.0 fix: every registry factory used to default to `seed: 1`, so two tables minted the same uuid and a join assertion could pass for the wrong reason.

`ids.uuid()` and `ids.number()` come from the seeded generators; `index` starts at 1 for the first row.

`factoriesFor(registry, seed?)` derives a factory per entity with name-based column inference — `id`/`*Id` → uuid, `*At` → epoch, `*Minor` → number, `*Currency` → `'USD'`, `is*`/`has*` → `false`, else `<column>-<index>`.

### Persisting

`create()` needs a persister; there is one seam and it is process-global.

```ts
// scripts/test-setup.ts
usePersister({ insert: (table, row) => repoFor(table).insert(row) });
```

Without one, `create()` throws `X_TEST_FACTORY_NOT_PERSISTED` — which means **nothing was attempted**, distinct from an insert that failed. `build()` needs no persister. `clearPersister()` and `persisterInstalled()` round out the seam.

## Shared examples

One contract, asserted against many subjects, with the subject passed as a **thunk** so a `beforeAll`-built value is read at test time rather than at declaration time.

```ts
const anAuthenticatedAction = sharedExamples<Denier>('an authenticated action', (subject) => {
  test('denies an anonymous actor', () => {
    expect(subject().denies('anonymous')).toBe(true);
  });
});

describe(testName('unit', 'publishPost'), () => {
  behavesLike(anAuthenticatedAction, () => publishPost);
});
```

`behavesLike` wraps the body in `describe('behaves like <name>')`, so a failure reads `publishPost > behaves like an authenticated action > denies an anonymous actor` — the subject and the contract both named. Because it calls `describe`, it belongs at declaration scope and never inside a test body. The body runs once per `behavesLike` call.

Two contracts ship as shared examples, for the ports an app may implement itself: `behavesLike(jobDriverConformance, () => myDriver)` holds a custom `JobDriver` to claim / ack / nack, the claim fence, lease expiry and the burial of a row whose lease lapsed on its final attempt (`onExhausted`, `dropExhausted`); `behavesLike(budgetStoreConformance, () => myStore)` races 24 concurrent `take`s on one key against an `@ultimat3/ai` `BudgetStore`. The memory and Postgres job drivers and `MemoryBudgetStore` run the same suites in `@ultimat3/testing`'s own tests.

## Generated scaffolds

Every generator writes the tests beside what it wrote, and the `unit` half RUNS the code — the
coverage floor counts that suite alone, so a body only a typed suite reaches is uncovered source.
`As of 2026-10`.

| Generator | `unit` (in process, in-memory driver) | Its typed suite |
|---|---|---|
| `x g action` | input parse; the handler through `.as(actor, input)` — the refusal first, then what it answers | `contract`: the action contract, the foreign-org denial, the OpenAPI operation |
| `x g mutator` | the same, plus `local()` against `memoryLocalTx()`, applied twice | `contract` |
| `x g query` | the SQL's bound, total order and direction; the read through `.as()` — no grant refused, an empty org reads empty, stored rows read back newest first and never another org's | `--live`: the declaration in `.live.test.ts` |
| `x g job` · `x g task` | the body under `runJobs`: which steps one run takes, what it answers, and how it ends | `job`: key, tenant, retry policy, enqueue dedupe |
| `x g backfill` | one whole pass over rows in two tenants; the projection replayed | `job`: durable name, dedupe |
| `x g route` | the page rendered (`renderRoute`): heading, metadata, mode, budget, islands | `e2e`: the offline fallback |
| `x g resource` | every row above for its slice, plus `page.test.ts`: the page rendered as the request's actor — the org's rows newest first beside the form island, the empty state, a member of another org reading none of them, and the refusal rendered inside the page | `e2e`: the offline fallback |
| `x g island` | a `describeIslandState` block per state the `.island.states.ts` declares | — |
| `llm` prompt | — | `eval`: an evals file (missing evals fails `x verify`) |

A stored-row case is written only into a slice whose entity still has the columns `x g entity`
scaffolds; one an author reshaped gets the cases that need no row.

## Memory, width and isolation

`As of 22.7`. The gate is built for the machines it runs on — 8-16 GB, 2-8 cores, often two agents'
gates at once — and it is held to a **memory budget**, not to whatever looks free.

- **Width.** `min(4 GiB, max(2.75 GiB, 25% of total RAM))` divided by 1.25 GiB a worker, clamped to `1..cores`:
  3 workers on a 16 GB box, 2 on an 8 GB one (the 2.75 GiB floor). Never more workers than cores. The step line says
  what it chose and why — `3 workers (budget 4.0 GB)`. `ULTIMATE_TEST_MEMORY_BUDGET=3g` replaces
  the budget, `ULTIMATE_TEST_MAX_WORKERS=2` caps the width, `--workers N` wins over both. Total RAM,
  never "free": page cache counts as free, and two gates each planning on it took a 45 GB box down.
- **One budget per machine.** Each batch of workers leases that many slots from a pool of lock
  files under the OS temp dir (one per worker the budget allows; a dead holder's slot is taken
  over). A second `x test` or `x verify` on the same box gets what is left and runs narrower, or
  waits for one slot, instead of doubling the memory. `ULTIMATE_TEST_SLOTS=0` turns it off.
- **No per-file isolation by default.** A worker keeps one global and one module registry across
  the files it runs (`bun test --parallel=N --no-isolate`) — measured 2-5x faster than `--isolate`
  at the same width. Between two files the testing preload hands the next file the process it would
  have had alone: undisposed island mounts are disposed, `globalThis` and `process.env` go back to
  the first file's baseline, the permission/role/catalog registries are restored (as a union — a
  module imported once per worker declares once), tasks exactly (an `anonymous-task-<n>` or
  `anonymous-job-<n>` name is never re-minted in a process — `resetTasks()`/`resetJobs()` clear
  the registry, not the counter — so a later file's task cannot take an earlier one's seat), and
  `.tsx` always compiles with the app's JSX factory. A repository whose tests need a fresh global per file says
  `"isolate": true` in `x.verify.json`, or passes `--isolate` to `x test` / `x verify`.
- **One long-lived process per worker.** Without isolation a worker's memory is set by its live
  database, not by how many files it ran, so a pass is ONE `bun test --parallel=N` (recycled only
  past 256 files a worker; 24 under `--isolate`, whose heap grows per file). Every parallel run
  reads and refreshes `.x/test-timings.json`, so Bun starts the slowest files first.
- **One database per worker.** `reusableDatabase(open)` from `@ultimat3/testing` opens an
  embedded database once per worker and resets its DATA to the template between files (truncate,
  re-insert the snapshot, reset sequences, triggers off meanwhile) — a PGlite boot from a migrated
  template costs 2.4-7 s, which a per-file database pays in every file.

Measured, `As of 2026-09-27`, 12-core box, whole process tree sampled every 200 ms:

| run | workers | wall | peak RSS |
|---|---|---|---|
| notificado.co `x test unit` (768 files), 22.6.2 default (isolated) | 14 (+parent) | 193 s | 13.1 GB |
| the same, 22.7 default (16 GB+ box), test DB on `reusableDatabase` | 3 | 90-93 s | 3.7-3.9 GB |
| the same, 2 workers (an 8 GB box's default) | 2 | 150 s | 2.6 GB |
| framework `x test unit` (1620 files), no isolation | 3 | 115-125 s | 2.9-3.0 GB |
| framework `bun run verify` (whole gate, `"isolate": true`) | 3 | 227 s | 3.4 GB |

The framework repository itself opts back into `"isolate": true`: its suites exercise the
process-global registries on purpose (fixture apps per test, empty permission sets), and without
isolation a handful of files fail depending on which worker ran what before them. Apps do not
need it — notificado.co's unit, contract and job tiers pass without isolation.

A worker on the embedded database (PGlite) cannot go much below 1 GB: one booted PGlite holds
0.9-1.1 GB RSS even after `close()` and a full GC.

For CI, where wall time matters more than one box's memory, the gate splits across jobs:
[CI: the gate across parallel jobs](CI-Parallel-Gate).

## Coverage

95% of lines and 95% of functions — one bar, for the framework's packages and for every app.
Held by the `unit` step: lint and tests alone are not green.

| What | Rule |
|---|---|
| Measured over | every `.ts` / `.tsx` under the app's `apps/` and `packages/`. Not tests, `.d.ts`, `node_modules`, `dist`, `build`, `.x` |
| A file no unit test loads | counts at **0%**, weighed off its source. Bun's own summary averages loaded files only — `dummy/social-media-clone` read 91.7% of lines that way and is 67.5% over its whole tree (24 files nothing loads, `As of 2026-10-01`) |
| A barrel, a types-only module | weighs nothing: it emits no code |
| Which suite | `unit` only. An opt-in suite cannot hold a floor every default run must meet |
| The floor | `coverage` in `x.verify.json`. `x new` writes 95 / 95 |

```json
{
  "steps": ["unit"],
  "coverage": {
    "lines": 95,
    "funcs": 95,
    "exclude": [{ "glob": "apps/*/server.ts", "why": "the container entry point" }]
  }
}
```

| State | Finding on `unit` | Fix it carries |
|---|---|---|
| no `coverage` | `X_COVERAGE_FLOOR_UNSTATED` | the exact line to add, with the measured numbers |
| a floor under 95 with no `why` | `X_COVERAGE_FLOOR_UNSTATED` | add `"why"`, or raise to 95 |
| measured under the floor | `X_COVERAGE_BELOW_FLOOR` — both numbers, and the ten files losing the most lines | `bun test --coverage <the worst file's test>` |
| a floor under 95, and the tree 1.5 points over it | `X_COVERAGE_FLOOR_STALE` | the numbers to write |
| an `exclude` with no `why`, a number that is not 0–100 | `X_CONFIG_INVALID`, on `manifest` | the shape to write |

- **The floor only rises.** Under 95 it may be nothing but what the tree measures: more than 1.5
  points over it is red until the floor moves up. No history is read — an app with no git is held
  the same.
- **`exclude` is for code a unit test cannot execute** — an island's browser mount (its test runs a
  built chunk), a container entry point. Each entry carries its `why`; `x doctor` prints them all.
- **A floor, not the goal.** Coverage counts execution, not validation: 100% is reachable with zero
  assertions. A test added to raise it is proven by mutation — break the source, watch it go red,
  restore. A covered branch whose test cannot fail is worse than an uncovered one.
- **Cost: none measured.** The step on `examples/dummy` (53 unit files): 7.5 s before, 7.5 s after
  (`As of 2026-10-01`).
- **Same number on every machine.** The suite runs as fixed slices of 16 neighbouring test files,
  one plain `bun test` each; the lcov parts are folded here. Not `bun test --parallel --coverage`:
  Bun's own cross-worker merge read one tree as 59.9% at four workers and 65.0% at two.
- **Functions** are counted per source file as the best one slice reached — Bun's lcov carries no
  function names to union. A directory's tests share a slice, so tests beside their source count
  together.
- **Under `--shard`** a slice cannot hold a floor: it is green on coverage, carries its facts in
  `data.coverage.unit.facts`, and `x verify merge` judges the fold → [CI](CI-Parallel-Gate).
- **In `--json`** a judged run carries `data.coverage.unit` — `{ "lines", "funcs", "files" }`. The
  human render prints the same line under the step with `--verbose`, and always when it is red.
- **A `.tsx` is counted in its COMPILED lines — a Bun inaccuracy, `As of 2026-10` (Bun 1.4.0).**
  Bun reports a plugin-loaded file under its source path with the output's line numbers and
  totals, and every rendered `.tsx` is compiled by a plugin. So `Uncovered Line #s` for a `.tsx`
  is not a place in the source, and a view whose tests assert every branch can still read under
  100%. Read the percentage, ignore the line list, and keep logic that needs a line-accurate
  answer in a `.ts` module beside the view. The minimal case:
  [`docs/history/bun-coverage-plugin-lines.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/history/bun-coverage-plugin-lines.md).

The framework holds itself to the same constant: `bun run coverage` gates each package and
`scripts/` alone, one process each (`scripts/coverage-gate.ts`).

## `x verify`

The single gate. Green means shippable.

Twenty steps, one list, in cost order. **The gate is this command with no flag** — "green" has to
mean the same thing for everyone. `x verify --only <step>[,<step>…]` runs the named steps — several
in one process — for an iteration loop and says `NOT A GATE RUN` in the summary and in `--json`
(`data.notAGateRun`), writing no floor file;
there is no `--skip`, because a knob that removes a step from a run still calling itself the gate is
the one thing this command must not offer. A step with nothing to check reports as skipped (`-`),
never as passed.

The list is defined once, as `VERIFY_STEP_NAMES` in
[`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts).
This table is a hand-synced copy of it ([Contributing](Contributing)).

| Step | Fails on |
|---|---|
| `typecheck` | any error; `any` is banned by lint, not tolerated by a cast |
| `lint` | biome only: formatting, `any`, default exports, unused imports. **Not** raw colours, bare `Error`, untranslated strings or unzoned dates — biome ignores `.scss` entirely and those are guards, one row down |
| `boundaries` | `site/` → `app/`, routes → DB, services → HTTP, tier violations in framework packages, **and every file in the app's own `guards/`** — every name in `SHIPPED_GUARD_NAMES` (`packages/cli/src/templates/scaffold-guards.ts`) that `x new` writes, or the ones you kept → [Interface rules](Interface-Rules) |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, or `src/index.ts` |
| `errors` | an `X_*` code with no runnable fix or no docs page |
| `unit` | pure logic — services, money, policy predicates, matchers; in an app, coverage under the floor in `x.verify.json` → [Coverage](#coverage) |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | a real browser (raw CDP, no Playwright) against the app, spawned on a throwaway database, when Chrome is on the machine; otherwise its browser cases skip, or refuse under `E2E_BROWSER_REQUIRED=1` |
| `eval` | a prompt scoring below its committed baseline, or a prompt with no eval at all |
| `drift` | schema differs from migrations, or a migration is not reversible-or-marked |
| `contract-diff` | a breaking change to a published action/query without a version bump |
| `budgets` | per-route JS bytes; a live hook on a route with no island is `X_LIVE_ROUTE_NO_ISLAND` |
| `seo` | an indexable `site/` route with no title, or no description a search result can render |
| `i18n` | a key missing from a locale's catalog, or a catalog no module ever registered |
| `policy` | a permission this app grants or requires that it does not declare. Skipped — never passed — in a repo with no `app.config.ts` |
| `manifest` | `x.manifest.json` / `openapi.json` differ from what the code produces, or `AGENTS.md` is missing or over its byte cap |
| `roadmap` | framework repo only — a milestone missing its status marker, or a shipped milestone missing an artifact its own row names |

Any failure fails the gate; flakes are failures.

```text
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ filesize  ✓ package-shape  ✓ errors
  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e  ✓ eval
  ✗ drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

**A step has a deadline, and a hung one fails by name.**

| Step | Deadline | Past it |
|---|---|---|
| `unit` `contract` `live` `job` `e2e` `eval` | 8 minutes | `X_VERIFY_STEP_TIMEOUT` on that step; every process it started is killed and the test file still running is named; the steps after it still run |
| every other step | 5 minutes | the same |
| one you name | `"stepTimeoutMs": { "unit": 900000 }` in `x.verify.json` | the same |

**`--json` says where it is.** One line per finished step on stderr —
`{"step":"lint","ok":true,"ms":21987}` — so a cancelled CI job's log ends on the last step that
finished. stdout stays the one document.

`x verify --json` emits the same content machine-readably → [MCP and AI](MCP-And-AI). CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check developers cannot run.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_SEALED` | a test reached the network without a mock | `mockFetch('<url>', …)`, or `allowHost('<host>')` if the call must be real — both from `@ultimat3/testing`. There is no `x test mock` subcommand |
| `X_FORBIDDEN` | the actor's policy refused — the assertion target of every denial test | `x actions describe <action> --json` names the capability it enforces: assert the denial with `.rejects.toBeUltimateError('X_FORBIDDEN')`, or grant that capability to the seeded actor's role in `apps/web/shared/policies.ts` |
| `X_INVARIANT` | a domain invariant was violated inside a test fixture | fix the seed or the invariant |
| `X_CONFIG_INVALID` | test config names an unknown worker count, driver, or test type | `x test --help` |
| `X_TEST_ISLAND_STATE_UNKNOWN` | an island test named a state its manifest does not declare | name one of the ids the cause lists, or declare the state in the `.island.states.ts` beside the island |
| `X_COVERAGE_BELOW_FLOOR` | the unit suite covers less of the app than `x.verify.json` states | `x verify --only unit --json` names the ten worst files; cover the first with a test beside it |
| `X_COVERAGE_FLOOR_UNSTATED` | no `coverage` in `x.verify.json`, or one under 95 with no `why` | the finding carries the line to add |
| `X_COVERAGE_FLOOR_STALE` | a floor under 95 the tree has left 1.5 points behind | raise `coverage` to the numbers the finding carries |
| `X_VERIFY_STEP_TIMEOUT` | a gate step ran past its deadline | `bun test <file>` when the finding names the stuck file; otherwise `x verify --only unit --json` reproduces the step alone |

Full list: [Error codes](Error-Codes).

## Rules

- Never mock the database. Clone it.
- Never assert on wall-clock time. Advance the frozen clock.
- Never let a test reach the network unmocked — it fails by design.
- A flaky test is deleted or fixed the day it flakes. There is no `retry: 3`.
- Every framework package ships at least 2 tests that would catch a real regression. No `expect(true).toBe(true)`.
- Tests live next to their source as `<file>.test.ts`.
- A denial test per policy branch, not one happy-path test per action.
- Every island declares its states, and the states worth declaring are the ones you cannot click to. What the pictures are then judged against: [Interface rules](Interface-Rules).
- Assert on error **codes**, never on error message text.
- CI runs `x verify` and nothing else.
