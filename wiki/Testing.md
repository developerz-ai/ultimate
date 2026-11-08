# Testing

`bun test`. N workers, N real Postgres databases, sealed network. No mocking the database, no rollback hacks, no shared-state flakes.

Tests live next to their source as `<file>.test.ts`.

## Parallel by database clone

```
x test unit --workers 4        # one bun test --parallel=4: Bun's workers 1..4
  worker 1 → ultimate_test_template_w1   (CREATE DATABASE … TEMPLATE ultimate_test_template)
  worker 2 → ultimate_test_template_w2
  ...
```

`--workers` is `x test`'s flag, spent as Bun's `--parallel`; `bun test` itself has no `--workers`.

| Step | Mechanism |
|---|---|
| Once per run | `pg_advisory_lock`, then the template database is created and migrated; the first worker builds it, the rest wait on the lock and reuse it |
| Per worker | `DROP DATABASE IF EXISTS … WITH (FORCE)`, then `CREATE DATABASE … TEMPLATE` the template — Postgres file-copies |
| Per test file | the worker's database with its DATA reset to the template's (`reusableDatabase`, below) |
| No `TEST_DATABASE_URL` / `DATABASE_URL` | PGlite in memory behind the same handle |
| Teardown | `drop()` on the worker's handle. There is no keep-the-database flag, `As of 2026-11` |

### Rejected approaches

| Common approach | Why rejected |
|---|---|
| Wrap each test in a transaction and roll back | breaks anything that commits: the outbox, `LISTEN/NOTIFY`, logical replication, real isolation levels, nested transactions, and every job test. You end up testing a code path production never runs |
| One shared test DB with serial tests | slow, and the first flake teaches everyone to re-run instead of read |
| One shared DB with parallel tests | shared-state flakes. The failures are order-dependent, unreproducible, and eventually the suite is ignored |
| Mock the database | tests pass, SQL is wrong. The main thing worth testing is the query |

Real databases, truly parallel, is the only combination that is both fast and honest.

## Database state, and what a run leaves behind

`As of 27.3.0`. The framework's DatabaseCleaner and `tmp:clear` in one place: every test starts from a known database by construction, and what a run leaves on disk or on the server is swept by the framework, never by the app.

**The migrated database.** `migratedDatabase({ root })` from `@ultimat3/cli` is a fresh embedded Postgres holding the framework schema (`x_jobs`, `x_users`, …) and every migration under `packages/db/migrations` — exactly what `x db migrate` applies. It boots from a template (the migrated data directory, dumped once per PGlite version, framework schema and migration set) cached at `<app root>/.x/test-db/pglite-<key>.tar`: a restore is ~0.5 s where initdb plus the migrations is 4-7 s. A changed migration is a new key, so a stale template is never loaded. The recipe, once per app, in the app's own test-support module:

```ts
import { migratedDatabase } from '@ultimat3/cli';
import { setDbClient } from '@ultimat3/db';
import { afterAll, beforeAll, reusableDatabase } from '@ultimat3/testing';

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

export function useMigratedDatabase(): void {
  beforeAll(async () => setDbClient(await workerDatabase()), 60_000);
  afterAll(() => setDbClient(undefined));
}
```

| Scope | What it gets |
|---|---|
| a test **file** | the worker's database with its DATA reset to the template's — every table truncated and re-filled, every sequence reset, triggers off meanwhile (`reusableDatabase`) |
| a **test** inside a file | the same database as the file's other tests: nothing is rolled back between them (a rollback would break every commit-dependent path). Give each test its own ids |
| DDL a test runs | not undone — a test that changes the schema opens its own `migratedDatabase` and closes it |
| a Postgres server (`TEST_DATABASE_URL`) | a database per worker cloned from the template (`describeApp`), or a per-run probe database (`probeDatabaseName`), dropped at teardown |

**The handle follows the installed client**, `As of 30.0`. The scaffolded `packages/db/src/client.ts` picks `testDriver()` under test (`storeMode(env) === 'memory' ? testDriver() : postgresDriver()`): memory until `setDbClient` installs one, that client while it is, decided per repository call. So `db.<table>` and a repo's raw `sql` join read and write one database in a file that runs the recipe, and a file that never runs it is the memory driver exactly: no PGlite loaded, no WASM cost. An app scaffolded before 30.0 makes that one-line edit in its own `client.ts`; until then its handle stays in memory while raw SQL reaches the installed client. Worked example: `examples/dummy/apps/web/app/posts/repo-join.test.ts`.

| The test is about | Suite |
|---|---|
| a repo's handle calls, a service, a policy | a plain `.test.ts` on memory |
| a repo mixing the handle with a raw join, an aggregate, a CTE | a `.test.ts` running the recipe above |
| behaviour only a real server has (a second connection, `LISTEN`, a lock across sessions) | `.live.test.ts` against `TEST_DATABASE_URL` |
| a raw join paged with `keyset()` | the recipe above: raw SQL has no memory path, so a page boundary is asserted on the real engine |
| text order where it matters | the recipe above, `As of 2026-11-06`. Memory sorts text by code unit (`["10","9","A","B","a"]`), Postgres by the column's collation (`["10","9","a","A","a b"]` on `en_US`): `.orderBy('name').page()` agrees on order only on the real engine |

**What a run leaves behind is swept** — before every `x test` and every test step of `x verify` (once per process), and on demand by `x clean`:

| Leftover | Before a run | `x clean` |
|---|---|---|
| `.x/test-db/pglite-*.tar` templates | the newest two stay — the current migration state and one a second checkout may be on. Writing a new one evicts the same way | all |
| `.x/cache` — PGlite initdb snapshots, the Sass cache | snapshots: the newest two stay | the whole folder |
| a `.x` below the app root (written beside the code by a process started in a source folder, before 27.3.0) | removed | removed |
| a probe database whose process is dead, with no connection, older than 10 min (`TEST_DATABASE_URL` set) | dropped | dropped |
| `.x/pgdata` (the dev database), `.x/storage`, the build output | never touched | never touched |

Every `.x` path a framework module writes resolves from the APP ROOT (`appStatePath` in `@ultimat3/core`), whichever folder the process started in. A temp directory a framework test makes is removed by the file that made it; `scripts/temp-dir-cleanup.test.ts` refuses one that is not.

## Determinism

Any test that can pass twice and fail the third time is worse than no test — it trains people to ignore red.

| Control | Behavior |
|---|---|
| **Seeds** | `seed(name)` builds a named, deterministic fixture graph via entity factories. Same input → identical rows, identical UUIDs |
| **Frozen clock** | time starts at a fixed instant. `clock.advance('3d')` moves it, and it also drives `step.sleep` and cron in tests |
| **Seeded RNG** | `Math.random`, `crypto.randomUUID`, and Bun's RNG are seeded per test file from its path — reproducible, distinct across files |
| **Sealed network** | a `fetch`, a `new WebSocket(…)` or a `Bun.connect(…)` to anywhere not explicitly mocked or allowed **fails the test** with `X_TEST_NETWORK_SEALED`, naming the URL and the fix — the three dials share one gate, so the allow-list and `offline()` apply to all of them — `offline()` refuses a loopback dial too (`X_TEST_NETWORK_OFFLINE`). A dial that goes around those three globals (a `node:net` socket, `Bun.udpSocket`) is not sealed |
| **Sealed names** | `Bun.dns.lookup`, `dns.lookup` and `dns.promises.lookup` ask the same gate: a host a `mockFetch` route names resolves to `MOCKED_HOST_ADDRESS` (`11.11.11.11`, public, so an SSRF screen such as `screenDial` passes it and the dial it pins still meets the mock by its `Host`); this machine, an address literal and an `allowHost` name resolve for real; offline refuses every name (`X_TEST_NETWORK_OFFLINE`); any other name is `X_TEST_NETWORK_SEALED`. A RegExp route names a host it matches at the origin or spells in its source. Not covered: `lookup` bound by a named ESM import (`import { lookup } from 'node:dns'`) before the seal, and `dns.resolve*` |
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

`mockFetch(match, answer)` holds what a retry test needs in one registration:

```ts
import { expect, mockFetch, requestLog } from '@ultimat3/testing';

declare function charge(): Promise<void>; // yours: the code under test

mockFetch('POST https://api.vendor.test/charge', [
  new Response('busy', { status: 503 }),
  new Response('{"id":"ch_1"}'),
]);
await charge();
expect(requestLog()).toHaveLength(2);
const [first, second] = requestLog();
expect(second?.headers['authorization']).toBe(first?.headers['authorization']);
expect(second?.body).toBe(first?.body);
```

- `match`: an exact URL, a prefix ending in `*`, or a RegExp, every verb. A string may name one verb first, `'POST https://…'`. An address-literal URL carrying a `host` header also matches a route on that name, so a pinned dial answers the mock of its host.
- `answer`: a handler, or a list of `Response | Error` answered in order with the last repeated. An `Error` is thrown. An empty list is `X_INVARIANT`.
- `requestLog()`: `{ method, url, headers, body }[]`, in call order, refused calls and socket dials included, unredacted. Header names are lowercase. `body` is UTF-8 text or `null`; a `ReadableStream` on its way to a real server is never read and logs `null`. A stream body or a `Request`'s own is captured beside the call, never ahead of the answer: it is in the entry once it ends, `null` until then.

**A vendor's answers, recorded once** — `cassette(dir, name, options)`, `As of 2026-11`. Replay is
`mockFetch`: each recorded URL becomes one route answered in call order, so anything else is still
`X_TEST_NETWORK_SEALED`. Recording is by hand.

```ts
import { cassette, expect } from '@ultimat3/testing';

declare function refund(): Promise<{ status: number }>; // yours: the code under test

await using _tape = cassette(import.meta.dir, 'refund-flow', {
  record: { hosts: ['api.vendor.test'] },
});
expect((await refund()).status).toBe(200);
```

| Mode | What happens |
|---|---|
| replay (default) | reads `<dir>/__cassettes__/<name>.json`; no file is `X_CASSETTE_MISSING`; an entry never asked for fails at dispose, `X_CASSETTE_UNUSED` (`meta.unused`) |
| `ULTIMATE_CASSETTE=record bun test <file>` | lets `record.hosts` through the seal for the cassette's life, and writes at dispose. `CI` set, no `record.hosts`, or a dial to another host is `X_CASSETTE_RECORD_REFUSED` |

| What is written | Rule |
|---|---|
| request | never: assert what was sent with `requestLog()` |
| response headers | `content-type`, `retry-after`, `ratelimit-*` only |
| credential-named keys | masked as `[redacted]` in JSON bodies at any depth and in URL queries; a masked URL still matches the real request on replay |
| `redact(text)` | the app's rule, after the masking, on each URL and text body; a `[redacted]` it puts in a URL matches any one segment on replay |
| the secret scan | last, over the exact bytes: every credential-named env var's value and `secrets: []`, raw, JSON-escaped, percent-encoded, base64, base64url, and raw inside a base64 body. A hit writes nothing: `X_CASSETTE_SECRET` names the key and the byte offset, never the value. Values under 8 characters are skipped; a hashed or split value is not caught |
| bodies | text as text, anything else base64; keys sorted; temp file then rename; a body that fails to read writes nothing |
| streams | recorded whole, replayed as one body: a chunk-boundary test stays hand-written |

Locale and zone are declared per test when the behavior under test depends on them — see [Timezones and dates](Timezones-And-Dates) and [I18n](I18n).

## The six test types

| Type | Command | Asserts | Runs against |
|---|---|---|---|
| **unit** | `x test unit` | services, money, policy predicates, matchers, and a handler through `.as()` — what runs in process | the in-memory driver, or the migrated database recipe above (`migratedDatabase` + `reusableDatabase`) when the code reads Postgres |
| **contract** | `x test contract` | an action's input/output schema, its policy denials, its emitted OpenAPI + MCP tool shape, its handler on generated legal input | cloned DB |
| **live** | `x test live` | a live query's initial snapshot, incremental patches on write, reconnect delta, and that a policy-failing row is never delivered | cloned DB + in-process replicator + in-process NATS |
| **job** | `x test job` | step-level replay (a step already run is not re-run), idempotency-key dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback | cloned DB + frozen clock |
| **e2e** | `x test e2e` | a real browser (Chrome over raw CDP, no Playwright) against the app: render mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload, two tabs, offline writes | the app spawned on a throwaway database (`ULTIMATE_STATE_DIR`) + a real browser, when Chrome is present |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

**Each helper takes `{ timeoutMs }`** — `unitTest(name, body, { timeoutMs: 30_000 })`, the same
on `contractTest`, `liveTest`, `jobTest`, `e2eTest` and `test`, and a key of `evalTest`'s options.
Handed to `bun:test` at this machine's pace; absent is Bun's 5 s default, paced the same way. Never `test(testName('unit', …), body, 30_000)`
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
answered 500 with `X_ENV_MISSING`. `DATABASE_URL` and `S3_ENDPOINT` are stripped too (25.0.0,
#674): the state directory owns the database and the disk, and an exported integration-test
Postgres made `x db reset` refuse an external database and the step go red. A run that wants an
external one passes it in `startE2eApp({ env })`. Readiness is polled over `node:http`, because the e2e preload
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

**An agent's prompt takes the `agent` arm** — one case is one whole `agent.run()`, its tools and its
turns, under the gateway handed to `run` / `assert`. The prompt arm sends one request with no tools,
which measures something an agent never runs. `As of 2026-11`:

```ts
import { calledTool, contains, defineEval, type EvaluatedAgent } from '@ultimat3/ai';
import type { Actor } from '@ultimat3/core';

declare const supportAgent: EvaluatedAgent<{ question: string }>; // yours: an agent() action
declare const reviewer: Actor;

export const supportEval = defineEval({
  name: 'support.answer',
  agent: supportAgent,                       // an agent() action, registered
  cases: [{ name: 'where-is-o-1', input: { question: 'Where is o-1?' }, expected: 'shipped' }],
  tools: { lookupOrder: () => ({ status: 'shipped' }) },   // a double per tool the model may call
  scorers: [calledTool('lookupOrder'), contains],
  actor: reviewer,                           // optional: default is the `eval` service actor
  baseline: import.meta.resolve('./support.baseline.json'),
  tolerance: 0.05,
});
```

| Agent arm | Rule |
|---|---|
| a real tool | never runs: a call to a tool with no double is `X_EVAL_TOOL_UNDOUBLED`, thrown out of `run` / `assert` |
| a failed run (`X_AGENT_MAX_TURNS`, an invalid answer, a policy denial) | scores 0 on that case, its code in `cases[].failed`; the suite goes on |
| scorers | read `output` (the answer as JSON) and `run: { turns, toolCalls, usage }`; `calledTool(name)` is 1 or 0 |
| the report | `result.agent`, and per case `run: { turns, toolCalls }` |
| baseline | the same file, keyed by the agent's prompt hash; a model change is a new prompt version |
| coverage | an agent eval covers the agent's prompt; an uncovered one's `X_EVAL_MISSING` fix names the agent arm |

Recorded runs come from `scriptedProvider({ turns })`; harvesting production failures into `cases`
is the app's script — `transcriptOf(error)` hands over what happened.

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

## The accessibility audit

**Every `e2eTest` audits the browser's accessibility tree, `As of 2026-11`** (30.0.0 entry 88). After each settled `goto`, `reload` and `gotoStreamed`, and once more after the body (so a dialog the body opened counts), the driver reads the tree the browser computed for a screen reader and fails the test once, at the end, with `X_E2E_A11Y_VIOLATION` listing every element. There is no switch.

| Rule | Fails |
|---|---|
| `name` | a node of a `NAMED_ROLES` role with a blank accessible name: button, link, textbox, searchbox, combobox, checkbox, radio, switch, slider, spinbutton, tab, menuitem, image, heading, iframe, `<summary>` |
| `title` | the document with no `<title>` |
| `lang` | `<html>` with no `lang` |
| `aria-hidden-focus` | a Tab-reachable element inside `aria-hidden="true"` |

Name what it lists: visible text, `aria-label`, `<label for>`, `alt` (`alt=""` for a decorative image, which the browser then leaves out of the tree), a `<title>`, `<html lang>`. A deliberate exception is per test and per element, with a reason:

```ts
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest(
  'the gallery paints',
  async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  },
  {
    a11y: {
      allow: [
        { role: 'image', selector: '#vendor-map img', because: 'the vendor embed sets no alt' },
      ],
    },
  },
);
```

| Fact | |
|---|---|
| matching | `role` equals the finding's role and `selector` (CSS) matches the element, tested in the page |
| a blank `because` | the test is refused before its body runs (`X_E2E_A11Y_VIOLATION`) |
| a body that throws | fails on its own error; the audit verdict is not added |
| once per suite | a finding one test already failed on (rule, role, markup, URL) is not reported by a later test, so a shared header fails one test |
| not markup | a non-`http(s)` URL (`about:blank`) and a document that is not HTML (JSON, an image) are not audited |
| the page port | `E2eBrowserPage.accessibilityTree?(request)`. `cdpE2eTab` implements it with one `Accessibility.getFullAXTree` per read; a page passed to `installE2eDriver({ page })` without it fails every `e2eTest` with `X_TEST_FIXTURE_UNAVAILABLE`, never a silent pass |

**And every raw tab, `As of 2026-11-05`** (entry 88). A tab a suite drives itself (`browser.session.newTab()` off `openE2eBrowser()`, or the browser's first `page`) is read after each settled `goto` and `reload`, and once more at the test's end, and the findings fail that test from the preload's one `afterEach` — no suite opts in. A raw-tab test has no options slot, so its exceptions are a call, first in the body, before the navigation that lands on them:

```ts
import { test } from 'bun:test';
import { allowA11y, openE2eBrowser } from '@ultimat3/testing';

test('the vendor map renders', async () => {
  allowA11y([{ role: 'image', selector: '#vendor-map img', because: 'the vendor embed sets no alt' }]);
  const browser = await openE2eBrowser();
  try {
    const tab = await browser.session.newTab();
    await tab.goto('http://localhost:3000/map');
  } finally {
    await browser.close();
  }
});
```

An entry covers the reads after the call and ends with the test; a blank `because` is refused, as in `e2eTest`. Each `goto` now spends five CDP deadlines, not three (`E2E_GOTO_MS`), for the audit's two reads. Source: `packages/testing/src/e2e-a11y.ts` (rules), `e2e-a11y-run.ts` (one test's run), `e2e-a11y-tabs.ts` (raw tabs), `ax-node.ts` (the tree reader).

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

## Asserting on what an element carries

A string cannot say whether a node carries `aria-live`, or what its `onKeyDown` does. Walk the tree
instead, imported from the package that declares it, `@ultimat3/core/render-nodes`:

```ts
import { fire, one, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { Menu, type MenuItem } from '@ultimat3/ui';

declare const items: readonly MenuItem[];
const menu = one(withAttr(renderNodes(Menu, { items }), 'role', 'menu'), 'the menu');
fire(menu, 'onKeyDown', { key: 'ArrowDown', preventDefault: () => undefined });
```

| Question | Use |
|---|---|
| what a reader sees: markup, text, islands, `meta` | `renderRoute` / `renderView` (`@ultimat3/testing`) |
| what an element holds: handlers, refs, props no string can carry | `renderNodes` / `nodesOf` (`@ultimat3/core/render-nodes`) |

`nodesOf(value, { components })`: `'expand'` (default) calls components and keeps host nodes only;
`'keep'` keeps each component node beside its output, so `byComponent(nodes, 'DateTime')` reads
the props a view handed it; `'stop'` never calls one. An island's server shell is walked; a hole is
its first flush, `fallback` and `error`, and its deferred `children` are never called. `one()`, `attachRef()` and `fire()` refuse with `X_INVARIANT`, naming what they sought.
The worked example: `examples/dummy/apps/web/app/settings/page.test.ts`. `As of 2026-11`.

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
| `states[].routes` | stubs for whatever the component fetches: `{ kind: 'json', status?, body }`, `{ kind: 'records', status?, data, records, removed? }`, `{ kind: 'pending' }` or `{ kind: 'offline' }`, matched as a `"<METHOD> <pathname>"` prefix. `records` is what a query declaring an entity's `rows:` answers — the envelope behind `x-ultimate-records: 1`, built by core's `encodeRecordEnvelope` — so the page store adopts `records` (type → key → row) exactly as from the server; a `json` stub of the same body is read as bare rows and adopts nothing (25.0.0, #683). A malformed envelope is refused at declaration (`X_TEST_ISLAND_STATE_STUB_INVALID`) |
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
| `push` | `subscribe(actorId, { locale })` · `sent()` — each delivery decrypted, as the device shows it · `answerOnce(status)` | the preload |
| `runJobs` | enqueue+drain, then `enqueue()` `drain()` `tick()` `due()` `inFlight()` `depth()` → [A job under `runJobs`](#a-job-under-runjobs) | the preload |
| `statements` | `all()` · `count(fingerprint?)` · `shapes()` — and an N+1 fails the test | the preload |
| `page` | `goto` · `gotoStreamed` · `getByRole` · `evaluate` · `waitForServiceWorker` | a browser driver |
| `budget` | `jsBytes(route)` off the built output | a browser driver |
| `signIn` | put the browser session in a member's shoes | a browser driver |
| `deploy` | `newBuild()` — same app, new build id, page still open | a browser driver |
| `subscribe` | one subscriber's `rows()` `patches()` `settled()` `lsn()` | a replicator |
| `seed`, and anything else | the app's own graph | the app's `scripts/test-setup.ts` |

**`waitForServiceWorker({ timeoutMs? })` hands the first page over** (25.0.0, #678). The framework's register script runs on `load`, so the first page of a run is committed before its worker activates and `clients.claim()` can miss it: `ready` resolves and no `controllerchange` ever fires. The wait answers `ready`, gives the claim a second (`CLAIM_GRACE_MS`), and reloads an uncontrolled page ONCE — that navigation is answered by the worker — within one budget (`serviceWorkerTimeoutMs`, 10 s, or this call's `timeoutMs`). A page with no worker is refused without a reload, and a reload still uncontrolled is refused saying so (`X_E2E_SERVICE_WORKER_ABSENT`). Proven against a real worker that never claims: `packages/testing/e2e/service-worker-handover.e2e.test.ts`.

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
| `trace.executions[n].code` | the stable `X_*` code a failed run's error carried, beside its `error` message. Absent on an uncoded throw and on a run that did not fail |
| `trace.steps[name].executions` | times the step body ran — a replay from storage does not count. Cumulative for the test |
| `runJobs(job, input, { actor })` · `drain({ actor })` | the identity the **worker** runs as (`WorkerOptions.context()` in a real one). Its org is still the job's declared `tenant`; `tenant: 'none'` strips it. Absent is the anonymous actor |
| `runJobs(job, input, { tenantId })` · `enqueue(…, { tenantId })` | the **enqueuer's** tenant on the row: the limiter's bucket and the dedupe namespace, as `handle.as(actor, input)` files it. One key in two tenants is two jobs |
| the event bus | fresh per fixture: one test's `publishEvent` never resumes the next test's `step.waitForEvent` |

Enforced through it, keyed or not: `concurrency` and `whenBusy` — each pass is a real worker's `tick()`, so a run over its slot waits for the next pass, or is refused under `whenBusy: 'fail'`. The lease is renewed on the test clock — every millisecond of it — so a body in flight learns of a cancel at the next `clock.advance()`: cancel, `clock.advance(1)`, await the drain. A `clock.advance()` past the visibility timeout while it runs is `X_JOB_LEASE_LOST`, as in production. `As of 2026-10`.

## A job killed at every boundary, and raced from a seed

`crashProof(handle, input)` and `simulateJobs({ … })`, both from `@ultimat3/testing`, judge a job by its **effects** — row writes, mail, calls out, enqueues — never its return value. Reads are not effects. `As of 2026-11`.

| Call | Runs | Answers |
|---|---|---|
| `crashProof(job, input)` | one clean run, then one per distinct boundary it crossed (each step write landing, each settle), the worker killed there and the next one reclaiming; then each again with the write's answer lost. A loop's steps named by row id (`fanout:${row.id}`, `page-3` — a uuid, a digit run, an 8+ character token with a digit) are one point, killed at its first and last row: the cost is the job's steps, never the rows seeded. Over `CRASH_POINT_BOUND` (32) points per mode it throws `X_JOB_CRASH_UNBOUNDED` after the clean run, never a pass | `{ boundaries, crossed, divergences, reruns }` — `boundaries` the kills, `crossed` every boundary they stand for. A divergence carries `error`, an `X_JOB_CRASH_DIVERGED` naming the effect and the step it follows — `throw report.divergences[0].error`. A rerun is at-least-once, reported, never red |
| `simulateJobs({ jobs: [{ handle, input }], workers, faults, invariant })` | `seeds` (20) seeds from `seed` (1), N workers, every driver call interleaved and faulted by a seeded picker: `kill`, `answer-lost`, `lease-lapse`, `duplicate-claim`, `clock-jump` (`ALL_FAULTS`) | throws `X_JOB_SIM_INVARIANT` with the seed and its faults when `invariant(state)` throws or answers `false`; `X_JOB_SIM_NONDETERMINISTIC` when one seed traces two ways. `x test job --seed <n>` replays one |

A `compensates: true` job is also forced to fail for good and killed while it unwinds: each `compensate:*` once, last in first out. A kill inside `step.run(…, { once: true })` ends `X_STEP_OUTCOME_UNKNOWN` and is green. Postgres is not simulated. The reference: `examples/dummy/apps/web/app/posts/jobs.job.test.ts`.

## A model call under test

`echoProvider()` answers text; it cannot call a tool. A test that drives an `agent()` through its tools scripts the model with `scriptedProvider({ turns })`: each provider call answers the next turn, and `.seen` keeps every request in order.

```ts
import { configureAi, meteredRun, providerGateway, scriptedProvider } from '@ultimat3/ai';

declare const draft: { id: string; orgId: string };
declare function reviewDraft(input: { postId: string; orgId: string }): Promise<unknown>;

const model = scriptedProvider({
  turns: [
    { call: 'summarize', input: { postId: draft.id, orgId: draft.orgId } },
    { answer: { summary: 'Minor units and a currency.', tags: ['money'] } }, // the tool's own llm()
    { answer: { verdict: 'revise', notes: 'Say which rounding rule the body defends.' } },
  ],
});
configureAi({ gateway: providerGateway({ providers: [model] }) });

// The agent's turns and its tool's model call, as one bill: three calls.
const { billed } = await meteredRun(() => reviewDraft({ postId: draft.id, orgId: draft.orgId }));
console.assert(billed?.calls === 3 && model.seen.length === 3);
```

| Turn | The provider answers |
|---|---|
| `{ text }` | prose, `end_turn`: the JSON-in-text path, or a repair turn when it is not JSON |
| `{ call, input? }` | one tool call, `tool_use` |
| `{ calls: [{ call, input? }, …] }` | several tool calls in one turn |
| `{ answer }` | a `respond` call: the structured answer |
| any of them `+ { stop }` | that stop reason instead, `'max_tokens'` for a cut-off turn |

One call past the last turn is `X_AI_SCRIPT_EXHAUSTED`, never the last turn again: a loop that never answers fails the test instead of spinning to `maxTurns` on a script that looked like it passed. `usage` fixes every turn's token counts; absent, they are estimated from the request, as echo does. `As of 2026-11`.

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

A realtime island's page outlives its mount: the socket, the record store and the outbox sit on
`globalThis`, shared by every bundle. Between files (or cases that need a fresh page) call
`resetPageRealtime()` from `@ultimat3/realtime` in `afterAll` — it closes the socket the CHUNK's copy
of realtime built and drops every page global. Never `Reflect.deleteProperty(globalThis,
Symbol.for('ultimate.realtime'))`: that leaves the socket open. `As of 2026-11`.

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

## Testing a passkey ceremony

```ts
import type { PasskeyLogin } from '@ultimat3/auth';
import { softAuthenticator } from '@ultimat3/auth/soft-authenticator';

declare const passkeys: PasskeyLogin; // passkeyLogin(defineAuth({ adapter, passkeys: { rpId, origins } }))
declare const userId: string;

const key = await softAuthenticator({ origin: 'https://app.test' });
const created = await key.create(await passkeys.registerOptions({ userId }));
await passkeys.register({ userId, response: created });
const session = await passkeys.login({ response: await key.get(await passkeys.loginOptions()) });
```

`softAuthenticator` is a passkey with real WebCrypto keys (ES256 or RS256): `create(options)`
answers what `newPasskey` would in a browser, `get(options)` what `getPasskey` would, so the test
runs the server's real verification. One implementation and one path, `@ultimat3/auth/soft-authenticator`, the one
auth's own suites use. `As of 2026-11`.

## Testing a sign-in against an identity provider

`As of 2026-11`. `fakeIdentityProvider({ users, issuer?, clientId?, clock? })` is an OpenID provider
served through `mockFetch`, no socket: `/.well-known/openid-configuration`, a JWKS from a key it
generates, `/authorize` approving as the chosen user, `/token` (PKCE checked) and `/userinfo`.

```ts
import { discoverOAuthProvider, registerOAuthProvider } from '@ultimat3/auth';
import { expect, fakeIdentityProvider, unitTest } from '@ultimat3/testing';

unitTest('the provider registers from its own discovery document', async () => {
  const idp = await fakeIdentityProvider({ users: [{ sub: 'ada', email: 'ada@corp.test' }] });
  const provider = registerOAuthProvider(
    await discoverOAuthProvider({ id: 'corp', issuer: idp.issuer }),
  );
  expect(provider.jwksUri).toBe(idp.jwksUri);
  idp.tamper({ wrongKey: true }); // every token from here on fails the signature check
});
```

| Member | Does |
|---|---|
| `issuer` · `clientId` · `clientSecret` · `jwksUri` | what the app's provider registration and credentials take; `issuer` defaults to `https://idp.test`, `clientId` to `fake-client` |
| `signInAs(sub)` | who `/authorize` approves as next; the first user until called |
| `tamper({ wrongAudience?, expired?, wrongKey?, noEmailVerified? })` | every token minted after it is broken that way; `tamper({})` restores honesty |
| `idToken({ sub, nonce? })` | a signed id token, for a test that skips the redirect leg |

Each tamper is refused by `@ultimat3/auth`'s real `verifyIdToken` with the code a real provider's
broken token gets (`packages/testing/src/fake-identity-provider.test.ts`). An unknown `sub` and an
empty `users` are `X_INVARIANT`.

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
| **Both drivers report** | `memoryRepo` reports one event per repository operation under Postgres' own `entity.op`, with no SQL text, `As of 2026-11-02`, so the loop fails on the driver unit tests run on. Stricter in one place: Postgres serves a sibling lookup off a page it already read (`jit-preload.ts`), and memory counts it |
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
import { boolean, entity, integer, text, uuid } from '@ultimat3/entity';

const org = entity('orgs', { columns: { id: uuid().primaryKey(), name: text() } });
const post = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => org.id).tenant(), // the column `associations` fills
    title: text(),
    published: boolean().default(false),
    views: integer().default(0),
  },
});

const orgFactory = defineFactory(org, {
  defaults: (index, ids) => ({ id: ids.uuid(), name: `org-${index}` }),
});

const postFactory = defineFactory(post, {
  // `defaults` names every column; `associations` replaces `orgId` with the parent's id.
  defaults: (index, ids) => ({
    id: ids.uuid(),
    orgId: '',
    title: `post-${index}`,
    published: false,
    views: 0,
  }),
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

`factoriesFor(registry, seed?)` derives a factory per entity, each value read off the column's **declaration**, never its name (`As of 2026-11`, 30.0.0 entry 89): the declared default first, else an enumerated value, else what the kind offers (uuid, text, integer, boolean, timestamp, money as `{ minor, currency }`, …), and `null` only where the column is nullable. A text column held to a `matches(/…/)` invariant is also offered strings built from that pattern, and those come first; a `json(schema)` column is offered values its schema accepts (`As of 2026-11-07`). Every candidate goes through the column's own `$parse`, so a built row is one the table stores. A registry entry whose `$columns` are not `entity()` columns, or a column that refuses every generated value (a `json()` whose schema carries a `pattern` its sampler cannot meet), throws `X_SEED_GRAPH_UNSATISFIED` at `build()`, naming the `defineFactory` to write. Source: `packages/testing/src/factory-registry.ts`, `seed-graph-values.ts`.

### Persisting

`create()` needs a persister; there is one seam and it is process-global.

```ts
// scripts/test-setup.ts
usePersister({ insert: (table, row) => repoFor(table).insert(row) });
```

Without one, `create()` throws `X_TEST_FACTORY_NOT_PERSISTED` — which means **nothing was attempted**, distinct from an insert that failed. `build()` needs no persister. `clearPersister()` and `persisterInstalled()` round out the seam.

### A whole graph: `seedGraph`

Rows for every table, with no factory written. Pure: it returns a plan, `insertSeedGraph` writes it.

```ts
import { entity, enumerated, text, uuid } from '@ultimat3/entity';
import { insertSeedGraph, type SeedWriter, seedGraph } from '@ultimat3/testing';

const orgs = entity('orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 80 }) } });
const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    status: enumerated(['draft', 'published'] as const),
  },
});

const graph = seedGraph({ orgs, posts }, { tenants: 2, perTable: 3, seed: 7 });
// graph.order is ['orgs', 'posts']: one org per tenant, three posts in each

declare const writer: SeedWriter; // insert, update and snapshot, over your driver
await insertSeedGraph(graph, writer);
```

| Rule | What it does |
|---|---|
| order | parents before children, over the entities' own `$references()` |
| tenancy | each child points at a parent of its **own** tenant; the entity a tenant column references holds one row per tenant, keyed by the tenant. A table with no tenant column whose references reach a tenant-owned one, and no `shared` reason, is seeded per tenant too, under its own tenant's parent — `row.tenant` is that parent's tenant. A `shared` (or tenantless) table a tenant-owned one references through a key unique across the table — the unique holds the reference and not the tenant column — seeds `perTable` rows **per tenant**, still `tenant: null`, so every tenant's unique children find a parent row no other tenant took (`As of 2026-11-08`) |
| a cycle | broken at a nullable key: inserted `null`, set by an entry of `graph.updates` once its target exists. The break prefers a table that takes updates — never an `appendOnly` one, whose key stays `null` when it is the only break. In `x exercise`, a deferred update the database refuses (a trigger no declaration carries) leaves the key `null`; an environment failure still fails. A cycle with no nullable key is `X_SEED_GRAPH_UNSATISFIED` |
| values | read off the declaration, as `factoriesFor` reads them, and kept only if `$parse` accepts them |
| patterns and schemas | a `matches(/…/)` pattern adds strings drawn from the pattern itself — `patternSamples` (`@ultimat3/schema/sample`), the one generator the input sampler uses too: literals, classes, `.`, groups, `\|`, quantifiers, anchors. Lookaround, backreferences, `\b` and `\p{…}` add nothing, so the column's other candidates stand. A `json(schema)` column draws from its schema, as the contract step's `arbitrary` does. Both are seeded by the row, so the same seed gives the same bytes |
| rules | every invariant, the primary key, unique columns and unique indexes are kept; a partial unique is treated as total. A unique column that runs out of values ends its table early — but a table-wide unique that runs out before every tenant holds a row is `X_SEED_GRAPH_UNSATISFIED` (`… runs out of values before tenant 2 of 2 holds a row`): that tenant's children would have no parent |
| an unseeded target | a key — the tenant column included — whose target entity is not in the set is `X_SEED_GRAPH_UNSATISFIED` (`… which is not in the set seeded — pass it too`) |
| soft delete | a soft-deleting table's `deletedAt` is `null` unless a factory builds it: seeded rows are live |
| `factories` | `{ factories: { posts: myFactory } }` — what the factory builds wins, except keys and the tenant column, which stay the graph's |
| determinism | defaults `tenants: 2`, `perTable: 3` (per tenant for a tenant-scoped table), `seed` the package's `DEFAULT_SEED`. Same seed, same bytes |
| `beside` | `{ beside: earlier }` — a graph already written to the same database. Each table's row positions (the ordinal a generated integer, date or money is built from; a factory's `index`, reached by replaying its builds after `reset()`) continue past `earlier.next[table]`, so no value built from a position repeats one of its rows on a unique column. `graph.next` is cumulative: chain a third graph beside the second |
| canaries | each row's generated text carries a token; `graph.canaries` lists it per row with the columns holding it, so a later read can say whose row it saw |
| writing | `insertSeedGraph(graph, writer)`: every insert in order, then every update, sequentially. `entitySeedWriter({ entities, client })` (Postgres or PGlite) or `entitySeedWriter({ entities, driver? })` (a driver; default `defaultDriver()`) writes through each entity's own repository. A row whose entity the writer was not given is `X_SEED_GRAPH_ENTITY_UNKNOWN` |
| `snapshot(rows)` | **required** on a `SeedWriter`: one digest per row, read back by primary key, in the order given; `null` for a row gone. Soft-deleted rows are read too. `entitySeedWriter` answers `md5(t::text)` per row over a client — the whole stored row, undeclared columns included — and an md5 of the row's sorted JSON over a driver. The tenant proof's write half |

`X_SEED_GRAPH_UNSATISFIED` names the table, the columns to supply and the `defineFactory` call. `As of 2026-11-05`, `seed-graph.live.test.ts` inserts both tracked apps' schemas into Postgres with no factory, and `seed-graph-pglite.test.ts` the same into PGlite, in the unit step. Source: `packages/testing/src/seed-graph*.ts`.

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

Two contracts ship as shared examples, for the ports an app may implement itself: `behavesLike(jobDriverConformance, () => myDriver)` holds a custom `JobDriver` to claim / ack / nack, the claim fence, lease expiry and the burial of a row whose lease lapsed on its final attempt (`onExhausted`, `dropExhausted`); `behavesLike(budgetStoreConformance, () => myStore)` races 24 concurrent `take`s on one key against an `@ultimat3/ai` `BudgetStore`. The memory and Postgres job drivers and `memoryBudgetStore()` run the same suites in `@ultimat3/testing`'s own tests.

## Generated scaffolds

Every generator writes the tests beside what it wrote, and the `unit` half RUNS the code — the
coverage floor counts that suite alone, so a body only a typed suite reaches is uncovered source.
`As of 2026-10`.

| Generator | `unit` (in process, in-memory driver) | Its typed suite |
|---|---|---|
| `x g action` | input parse; the handler through `.as(actor, input)` — the refusal first, then what it answers | `contract`: the action contract (the exercise as a member of the input's org), the foreign-org denial, the OpenAPI operation |
| `x g mutator` | the same, plus `local()` against `memoryLocalTx()`, applied twice | `contract` |
| `x g query` | the SQL's bound, total order and direction; the read through `.as()` — no grant refused, an empty org reads empty, stored rows read back newest first and never another org's, the read costing one `statements` count however many rows it answers | `--live`: the declaration in `.live.test.ts` |
| `x g job` · `x g task` | the body under `runJobs`: which steps one run takes, what it answers, and how it ends | `job`: key, tenant, retry policy, enqueue dedupe |
| `x g backfill` | one whole pass over rows in two tenants; the projection replayed | `job`: durable name, dedupe |
| `x g route` | the page rendered (`renderRoute`): heading, metadata, mode, budget, islands | `e2e`: the offline fallback |
| `x g resource` | every row above for its slice, plus `page.test.ts`: the page rendered as the request's actor — the org's rows newest first beside the form island, the empty state, a member of another org reading none of them, the refusal rendered inside the page, and the list sorted and paged by link; `page-db.test.ts` asks the same sort and pages of the app's migrated database (`migratedDatabase` + `setDbClient`), the read's SQL path | `e2e`: the offline fallback |
| `x g island` | a `describeIslandState` block per state the `.island.states.ts` declares | — |
| `llm` prompt | — | `eval`: an evals file (missing evals fails `x verify`) |

A stored-row case is written only into a slice whose entity still has the columns `x g entity`
scaffolds; one an author reshaped gets the cases that need no row.

## The exercise assertion

`.contract()`'s fourth assertion calls the handler with generated input its own schema accepts.
A legal input that crashes the handler is red in `contract`, the day the action is written.
`As of 2026-11`.

| Rule | |
|---|---|
| **One declaration** | in an app, an action's exercise lives in `apps/web/exercise.ts` and nowhere else: `import { exercise } from '<…>/exercise'` then `action.contract({ exercise })` — the whole `defineExercise()` value, of which the contract reads the entry named for the action. `x exercise` reads the same entry, so a test and the pass cannot disagree on who acts. An entry declared only inline in a test is one `x exercise` cannot see (it reports the primitive `unreached`). `As of 2026-11-08` |
| Who acts | the entry's `actor`. Required unless the policy admits an anonymous caller: no entry is `X_CONTRACT_EXERCISE_UNDECLARED`, its `fix:` the `defineExercise({ <name>: { actor } })` line to paste. An entry with no `actor` (`{ input }` alone, which typechecks) runs signed out where the policy admits it, else is `X_CONTRACT_EXERCISE_UNDECLARED` too: `x exercise` picks a role, a contract test has none to pick from (`As of 2026-11-08`). There is no bypass: a policy that denies `actor` makes an unreached run |
| Inline, for a test's own world | `action.contract({ exercise: { actor, input } })` — one entry, not the app's — only when the test binds rows it seeded itself (`seed('dev').pick(…)`, an `actorFor`): those ids exist in that test alone. Kept and not deprecated; the who-acts of the primitive still belongs in `apps/web/exercise.ts` |
| A row | `{ actor, input: (drawn) => ({ ...drawn, postId }) }` binds what a generated uuid cannot resolve |
| Opting out | `{ off: '<reason>' }` as the entry. The reason is in the test's name. A blank one is `X_CONTRACT_EXERCISE_UNDECLARED` (`defineExercise` refuses it as the file loads) |
| Runs | 16 (`EXERCISE_RUNS` from `@ultimat3/core`), `runs` from 1 to 64. Runs 0-3 sit on the IR's bounds (`minLength`, `maxLength`, `minimum`, `maximum`, `minItems`). The rest draw multibyte text, every enum and union member, optional keys on and off, `null` where nullable. A format value (`t.uuid`, `t.email`, …) is never varied. A `t.string.pattern(/…/)` no drawn text meets is walked from the pattern itself (days, months, hex digests, digit ids, base64url tokens), inside its length bounds; the minimal draw keeps `'sample'` when the pattern accepts it (`As of 2026-11-08`) |
| Seed | `fnv1a(<action name>)`, never time, so a red run replays: `bun test <file> -t '<name>: handler survives generated input'` |
| Rolled back | each run inside a memory transaction, always, and in it `withTransaction` when SQL can hold the writes: a SAVEPOINT in a test's open transaction, a root transaction once `setDbClient` installed a client. Both always roll back. The handler's SQL writes, its memory-store writes (`storeMode` `memory`, `tx` passed or not, since `memoryTransactor().run` is ambient), the outbox stage and the post-commit bust drop with it (`packages/action/src/tx-scope.ts` `inRolledBackScope`) |
| **Not rolled back** | a write on a second client or `outsideTransaction`. A job enqueued with `outbox: false`. Storage puts. Mail and outbound fetch: the test preload seals both, so a real one is only sent where a test opted out. An audit record a non-database sink accepted |
| Rate-limit counters | spent in a scratch store of the exercise's own (`withScratchRateLimitStore`, `@ultimat3/http`), answering for the installed store's scope: the same file's next call has its whole declared limit |
| Where it runs | `development` and `test` only. `staging` or `production` (`ULTIMATE_ENV`, else `NODE_ENV`) is `X_CONTRACT_EXERCISE_ENVIRONMENT` before the first run: generated input never reaches a deploy. `bun test` sets `NODE_ENV=test` |
| Pass | the output parsed, or a coded refusal under 500 |
| Defect, `X_CONTRACT_DEFECT` | an uncoded throw, `X_OUTPUT_INVALID`, or a coded 5xx (an undeclared `errors:` code is one). `meta.run`, `meta.input`, `meta.failure` |
| Red, `X_CONTRACT_EXERCISE_UNREACHED` | no run reached the handler. `X_TEST_NETWORK_SEALED` counts as unreached, its host in `meta.outcomes` |
| Red, `X_CONTRACT_DRIFT` | the schema refused every draw: a provider refinement the IR does not carry, or a `pattern` past the generator's subset (lookaround, backreferences, `\b`, `\p{…}`), named in the cause as `field (must match …)`. Bind it with `exercise.input` |

A query has the same assertion, read off the same file: `orgFeed.contract({ exercise })`, named
`<name>: read survives generated input`. "Reached" is `sql()` building a source, and a read
writes nothing, so no transaction wraps it; it refuses a deploy the same way. Both are one loop,
`@ultimat3/core`'s `runExercise`: the verdicts above are the same words for a read and a write.
The generators declare an actor (`x g action`, `x g resource`), holding the slice's grant: a hand-written `policy.ts`'s one literal
`can('<perm>')`, or `{ off }` when its grant cannot be read. As of 2026-11-08 the call is `target.contract({ exercise })` and the actor is the ENTRY the generator inserts into `apps/web/exercise.ts` (`userActor({ id: 'member', orgId, permissions: [grant] })`, its draw's `orgId` bound under a tenancy rule; `x new` writes its example slice's the same way). The file is created from `x new`'s when absent; a file the generator cannot edit — no single `export const exercise = defineExercise({ … })` — is `X_EXERCISE_FILE_UNEDITABLE`, the entry to paste in its `fix:`. `x g query` emits no `.contract()` call: `x exercise` picks a reader by role.
`@ultimat3/schema/sample`'s `arbitrary(schema, { seed, run })` is the draw, off the barrel.

## The exercise pass

The exercise assertion asks of one action, in a test someone wrote. `x exercise` asks of the whole
app, with no test: every action, query and job, run once against generated rows. Same option
shape, same unreached code. `As of 2026-11`.

| Rule | |
|---|---|
| Database | a scratch one with the framework tables and every migration applied; never the developer's. The pass commits, so the tenant proof can read rows after the call |
| Rows | one seed graph for the pass, a fresh pair of tenants per primitive in it — the first the actor's (A), the second the tenant proof's intruder (B); every table seeded off its declaration, parents first, same-tenant keys (`x db seed --generate`'s graph). A view and a `readOnly: '<why>'` table get no row; a NOT NULL key into a `readOnly` one is `X_SEED_GRAPH_UNSATISFIED` naming it ([Read-only tables](Entities-And-Migrations#read-only-tables)) |
| Actor | the entry's `actor` when it declares one, seated in the primitive's tenant — and a top-level value of its bound input equal to the org the entry declared becomes that tenant too, so `input: (drawn) => ({ ...drawn, orgId: '<the actor's org>' })` holds in every tenant the pass seeds; otherwise the first of `x policy explain`'s actors the policy allows, in the primitive's tenant (an `{ input }`-only entry keeps this pick and still binds its input). None allowed is `refused`, by design. Its id has a user's shape: a uuid per role × tenant, the same on every run (`exerciseActorId`), never the role's name. Where the database has `x_users` (the framework schema every pass database is built with) each actor the pass acts as gets its row first — `<id>@exercise.invalid`, its tenant, roles, permissions, scopes — so `findUserById(ctx.actor.id)` finds it; a refused insert is `X_EXERCISE_ACTOR_USER_UNSEATED`. `defineExercise(…, { actor: members })` makes the id a seeded row's key instead (`As of 2026-11-08`) |
| Input | the override, then an id field whose stem names a seeded entity (`postId` → `posts`), then the schema's minimal draw. A wrong guess shows as `unreached` |
| A job's org | the field(s) its `tenant(input)` reads — any name, nested, left out of the draw, or under a parent the draw left out (a scoped backfill's `payload.input.orgId`) — are set to the tenant it is enqueued in, found by reading them: A's for the control, B's for the tenant proof (B's own job, carrying A's ids). A `tenant` no input field moves (one fixed org) is `unreached`, `X_JOB_TENANT_MISMATCH`, its `fix:` the declaration: `tenant: (input) => input.orgId` |
| A job's run | its own execution alone: enqueued on a queue holding nothing else, run by one worker pass. What it enqueues is left queued, as an action's is — an `enqueue` effect on its record, searched by the tenant proof, never run in its room. Its `statements`, effects, verdict and scale and plan sweeps are its own body's: a job that queues one child per row is flat, a body that reads each row is still `X_QUERY_SCALES_WITH_ROWS`. A child is judged as its own primitive. The crash proof too: its clean and killed runs claim only the job's own row, a child compared as its `enqueue:` effect |
| A job's failure | judged by the action rule: a coded refusal under 500 (an app's 409) is `unreached` under its own code, never a defect; an uncoded throw or a coded 5xx is `X_CONTRACT_DEFECT` |
| Async input | an override's `input` may be `async`: it is awaited inside the call's request, as the call's actor, so it can mint what the action checks (a one-time token, a passkey assertion). What it sends — a select, a row, a mail — is never the primitive's: each call is recorded alone, so it is not in the record's `statements` or `effects` and the plan sweep never plans it as the primitive's. One that throws is that primitive `unreached` under the throw's own code (an uncoded one `X_EXERCISE_INPUT_THREW`), its `fix` the entry to repair; the rest of the pass runs (`As of 2026-11-08`). `x drill`'s load skips an `async` input and says why |
| Room | network sealed, mail captured, jobs in memory, clock frozen — from before the app loads and the scratch database boots, as `bun test`'s preload does, so the embedded Postgres never sees its clock jump. A call out is refused and counted, so the primitive is `unreached` |
| Cost | rows are primitives × tables; statements are not: the graph is written one `insertAll` per table, each tenant-proof snapshot is one statement, and a primitive reads only its own pair's rows of the graph |
| Overrides | `apps/web/exercise.ts`: `export const exercise = defineExercise({ publishPost: { actor, input }, sendInvoice: { off: '<why>' } })`. The same value is what every contract test hands `.contract({ exercise })` ([one declaration](#the-exercise-assertion)). A key is a registered name or a kind-qualified one — `'job:eraseAccount'`, `'action:eraseAccount'`, `'query:…'` — which is that kind's alone and wins over the bare name — in `x exercise`, the contract step and `x drill` alike: an action and a job sharing a name each get their own entry, and the paste line a shared name prints is the qualified key (`As of 2026-11-08`). An unknown name, or a kind the name is not registered as, is `X_DECLARATION_UNKNOWN`; a blank `off` is `X_CONTRACT_EXERCISE_UNDECLARED` |
| A handler that calls a vendor | `defineExercise({ … }, { setup: () => { mockFetch('https://api.vendor.test/*', handler); } })` — or `setup: () => cassette(import.meta.dir, 'exercise')`. Runs once in the exercise process, after the seal and before the first row; what it returns is disposed after the pass. A call a setup route answers is reached, not refused. Several feature groups: `setup: [setupBilling, setupKyc]` — run in order, disposed in reverse, and one that throws disposes those that already ran before the pass refuses (`As of 2026-11-08`). `allowHost` in it is `X_EXERCISE_SETUP_UNSEALED` |
| A step held by a cookie | `defineExercise({ finishSignIn: { request: { cookies: { pending: '<value>' } } } })` — the call's inbound request carries it, read by `useRequestCookie()` / `useRequestHeader()` in the handler; `headers: { … }` beside it. A function `request: async (actor) => ({ cookies: { sid: await mintSession(actor) } })` is awaited before each call, as that call's actor (A's and B's each mint their own). A cookie goes in `cookies`, never a `Cookie` header: that, a name outside the token set or a header `Headers` refuses is `X_EXERCISE_REQUEST_INVALID`. Read by `x exercise` and the contract step alike: `.contract({ exercise })` runs each generated run inside that request (`withRequestAs`, `@ultimat3/http`); with no `request` its call has none, so a handler reading a cookie there is `X_CONTRACT_DEFECT` on `X_NO_REQUEST` (`As of 2026-11-08`) |
| Rows a generated value cannot satisfy | a cross-column `c.satisfies(…)` reads `X_SEED_GRAPH_UNSATISFIED`: `defineExercise({ … }, { factories: { bosses: defineFactory(bosses, { defaults: (i) => ({ … }) }) } })`, keyed by entity name, the graph's keys kept. A column that follows from a key or reference the graph picked: `derive: (row) => ({ scopeKey: … })` beside `build`/`reset`, reading `row.ownerOrgId`. A partial unique whose columns the factory builds is the database's to judge. An unknown name is `X_DECLARATION_UNKNOWN` |
| Drift | a schema no draw satisfies is `unreached`, `X_CONTRACT_DRIFT`; its `override` binds each field the sampler names as a gap with what it needs (`digest: "<must match ^[0-9a-f]{64}$>"`), the contract step's `fix:` the same `input:` (`As of 2026-11-08`) |
| Report | `.x/exercise.json` and `--json`: `{ seed, counts, records[] }`, each record `{ kind, name, outcome, code?, reason?, defect?, statements, effects, ms, override?, fix?, tenant?, crash? }` — `fix` where no override reaches it; `defect` on a 5xx: `{ cause, statement?, fields? }`, the error's own cause (a value the input held under a credential key or a `.sensitive()` field masked `[redacted]`), the SQL a database refusal names and the paths a validation failure names, all carried into the `X_CONTRACT_EXERCISE_UNREACHED` finding. The fields before `tenant` are A's call. The human table's `tenant` and `crash` columns are the verdicts, `-` where none ran |
| Gate | the `exercise` step, after `job`, runs `x exercise --json` as a child and is red on its findings: `X_CONTRACT_EXERCISE_UNREACHED`, `X_TENANT_LEAK`, `X_TENANT_WRITE_CROSSED`, `X_JOB_CRASH_DIVERGED`, and — on a whole pass, not `x exercise <name>` — `X_ENTITY_TENANT_UNDECLARED`. `unreached` is never sampled or skipped: it is a finding whose `fix:` is the entry to paste |

```bash
x exercise --json                 # the whole pass
x exercise publishPost --json     # one primitive, after pasting its override
```

### The tenant proof

**Every action, query and job is attacked from another tenant, around its own call**, `As of
2026-11`. Tenant B, holding the same role, sends exactly A's first input — A's seeded ids bound in.
Source: `packages/testing/src/tenant-proof.ts`, `tenant-canary.ts`, `tenant-proof-report.ts`.

| Leg | Who | Why there |
|---|---|---|
| `before` | B, with A's ids | a deleting action would leave B nothing to reach after A ran |
| control | A, its own call — the pass's ordinary run, the record's `outcome` | the positive control: a B that saw nothing proves only that A's call works |
| `after` | B again, same input | catches a cache entry A filled under a key missing the tenant |

| Half | Oracle |
|---|---|
| read | B's output, every captured mail (addresses, subject, text, html, unsubscribe url), every outbound call's url and body, every job B's call queued (its input; the primitive's own job excepted) — searched for a mark of A's: a row's canary, or a seeded key part ≥ 8 characters (`MIN_TAINT_ID_LENGTH`) no other tenant's row shares. A mark B's own input carried is no find: echoing the id B was handed proves nothing. Object keys are searched too |
| write | `snapshot()` over every row seeded for A — a child with no tenant column included — before and after each B leg. A digest that moved, or a row gone, is crossed |

B's actor is chosen as A's was, in B's tenant, with `tenancy:cross` stripped from its scopes: an
attack holding the escape would only prove the escape works. B being refused is never judged —
only what came back and what changed.

| Verdict | When — first match wins | Red |
|---|---|---|
| `crossed` | any finding, from either leg | yes: `X_TENANT_LEAK` (a path, `output.items[0].url`, `effect.mail[0].to`) or `X_TENANT_WRITE_CROSSED` (table and A's row id) |
| `unproven` | A's own call was not `reached` | no — the record is already `unreached`, which is |
| `public` | the policy admits an anonymous caller with an empty input: read half skipped, write half kept | no |
| `public` | a **job** whose B leg opened `crossTenant(reason, fn)` and whose input carried none of A's marks — a declared sweep, `sendDigest` fanning out one delivery per org. The reason is quoted in the verdict; read half skipped, write half kept | no |
| `public` | a **job** declaring `tenant: 'none'` whose input carried none of A's marks — a nightly cleanup across every org, input `{ occurrenceMs }`. No org and no id B chose reaches its run, so B's run is A's run: write half skipped (no snapshots taken), read half kept. Handed one of A's ids, crossed as ever. Both this and a declared sweep: both reasons, `; `-joined | no |
| `unproven` | a query whose A answer held none of A's marks: B's empty answer proves nothing | no |
| `proven` | otherwise | no |

`off` and `refused` records carry no `tenant`. A job has no policy, so it is `public` only as a
declared sweep or a `tenant: 'none'` job handed nothing of A's. `crossTenant()` is the one
declaration the proof reads (`@ultimat3/entity` tells a witness each scope opened, after its
capability is proven); it excuses nothing on an action or a query, which answer B directly, nor on a
job B handed one of A's ids — that is B choosing A's row, crossed as ever. `tenant: 'none'` excuses
only the write half, and only with no id of A's handed: an action or a query runs as B's actor, so a
write to A's row with no id in the input is a statement no tenant predicate scopes, crossed. A
finding prints paths, tables and seeded ids, never a bound value — one per leg and code, its places
listed once, a list index that only repeats collapsed (`effect.enqueue[*].input.orgId (3 each)`).
The fix on each: `x exercise <name> --json`, then read or write the row through the repository
scoped to `ctx.actor`; for a `tenant: 'none'` job handed nothing of A's, whose read has no org to
scope to, wrap it in `crossTenant('<why <name> reads every org>', async () => …)`. What this
does not walk — a `route` `load`, a `task` — is
[Policies and authz](Policies-And-Authz#the-dynamic-tenant-proof).

### The crash proof

**Every job the pass reached is killed at every step boundary**, `As of 2026-11`: `crashProof`
([above](#a-job-killed-at-every-boundary-and-raced-from-a-seed)) with the control's own input and
actor, after the tenant proof. Source: `packages/testing/src/exercise-crash.ts`,
`packages/cli/src/exercise-findings.ts`.

| Rule | |
|---|---|
| Runs | committed on the pass's scratch database, after the control. A job body runs outside every transaction, so no rollback scope can hold its writes, and an effect is counted when it commits |
| Oracle | the effect multiset — row writes through a repository, mail, calls out, enqueues — of each killed run against the clean one. Raw SQL is no effect, and reads are none |
| A job with no step | one boundary, before the ack: an effect in its body runs again on the retry |
| A sweep | one step per row is one kill point when the step is named by the row's id: a job over 1,500 seeded rows costs the runs one over 3 does. Steps named otherwise (a slug, an email) past 32 points are `unproven`, `X_JOB_CRASH_UNBOUNDED` |

| `crash.verdict` | When | Red |
|---|---|---|
| `diverged` | an effect made more often by a killed run: `findings[]` of `{ boundary, mode, effect, clean, killed, after?, inside? }` — `inside` the step whose body made it (`@ultimat3/jobs`' `currentStep()`), `after` the last step completed before it. An effect inside a step that did not complete, made FEWER times by a kill that spent one of its attempts, is not a divergence | yes: `X_JOB_CRASH_DIVERGED`, one per effect and place, every boundary named. Inside a step the fix keys its call on `${jobId}:<step>`; outside every step it wraps it in `step.run` |
| `held` | otherwise; `boundaries` (kills), `crossed` (boundaries they stand for) and `reruns` (lost answers — at-least-once, never red) counted | no |
| `unproven` | the proof itself threw, or could not finish in its bound: `reason`, `X_JOB_CRASH_UNBOUNDED: …` for the second | no |

**Where the time went.** Every record carries `proofMs: { tenant, crash, scale }` beside `ms` (the
control's own call); the report carries `phases: { seed, primitives, scale, plans, subject }`, in
milliseconds. No per-record plan time: one statement is planned once for every primitive that sent
it. The table's `tenant ms` / `crash ms` / `scale ms` columns, then
`took 44704 ms — seed 818 · primitives 41099 · … — slowest: primitives` and the five slowest
proofs by record, `slowest: job billing.plan-catalog · crash 35692 ms`. `As of 2026-11`.

The human output prints one line per killed boundary,
`job chargeOrder · killed at mail · X_JOB_CRASH_DIVERGED row:payments:insert 2× (clean 1×)`. The fix
reruns the one job and names the effect to move:

```bash
x exercise chargeOrder --json   # in job("chargeOrder"): wrap the "row:payments:insert" made after step "create" in step.run('<name>', async () => …)
```

### The plan and scale sweeps

**After every primitive ran, two sweeps, with no flag to turn either off**, `As of 2026-11`.
Source: `packages/testing/src/scale-sweep*.ts`, `plan-oracle.ts`, `plan-sweep*.ts`.

| Sweep | What | Red |
|---|---|---|
| scale | every reached primitive once more in a tenant at 2 rows a table, once in one at 8; per statement shape, the counts compared. Each sized seed is written beside the graph before it: row positions (a generated integer, a factory's `index`) continue past that graph's, so ``code: `c${index}` `` on a unique column never repeats the pass's own row | a shape sent more often at 8: `X_QUERY_SCALES_WITH_ROWS`, fix `preload()` or `expectedQueryLoop('<why>', fn)` |
| plans | every distinct statement whose first relation is an app table, `PREPARE`d and explained as a generic plan with `enable_seqscan`, `enable_bitmapscan`, `enable_sort` off, in a read-only transaction | `Seq Scan`, or an index scan with no `Index Cond` no `Limit` stops: `X_QUERY_UNINDEXED`. `Sort` under `Limit`: `X_QUERY_SORT_UNSERVED`, on the table its key names. Each prints an `indexes:` entry, one per arm for an `or`; a sort no declarable index serves (an expression, an aggregate, a derived column, keys across tables, mixed directions) or an index the entity already declares prints a rewrite or `expectedSeqScan` instead |

With the planner's scans and sorts disabled it picks one only when no index can answer, so the
verdict reads the schema on empty tables — no volume, no statistics. Never red: `scale.verdict`
`flat` (a declared loop listed in `expected` with its reason) or `unproven` (a call that did not
answer at both sizes); a statement whose equality pins a unique key; one a partial index serves once
its value is bound; a whole read beside a join whose join column leads a declared index on that
side, while the other side is bound by its own key — on empty tables a partial index the statement
implies looks like one row, so the planner walks it rather than probe it per row (`As of
2026-11-08`; with no such index the read is red and its `indexes:` entry is the join column); one
under `expectedSeqScan('<why>', fn)` or on an entity with `scan: '<why>'`
(`plans.exempt`); one generic planning refuses (`plans.unplannable`). A server below Postgres 12:
`X_QUERY_PLAN_UNAVAILABLE`.

```bash
x db gen posts-orgId-createdAt-id-index   # after indexes: [{ on: ['orgId', 'createdAt', 'id'] }] in entity("posts")
```

## Memory, width and isolation

`As of 22.7`. The gate is built for the machines it runs on — 8-16 GB, 2-8 cores, often two agents'
gates at once — and it is held to a **memory budget**, not to whatever looks free.

- **Width.** `max(2.75 GiB, 25% of total RAM)` divided by 1.25 GiB a worker, clamped to `1..cores`:
  3 workers on a 16 GB box, 12 on a 62 GB 16-core one, 2 on an 8 GB one (the 2.75 GiB floor). Never more workers than cores. The step line says
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
  the registry, not the counter — so a later file's task cannot take an earlier one's seat), every
  `mock.module` (`vi.mock`, `jest.mock`) the file made is put back to the real module — Bun keeps
  one past `mock.restore()` and past the file — and `.tsx` always compiles with the app's JSX
  factory. The real module is loaded for its snapshot before the fake goes in, so its top-level code
  runs; one that throws there cannot be put back, and the next file on the worker fails
  `X_TEST_MODULE_MOCK_UNRESTORABLE` naming the file that mocked it. A repository whose tests need a fresh global per file says
  `"isolate": true` in `x.verify.json`, or passes `--isolate` to `x test` / `x verify`.
  The framework repository itself still says `true`, `As of 2026-11`: `ai mcp` in one shared
  process went from 66 failures to 0 and `auth mcp ai testing` reads 0 (a test file's top-level
  `definePermissions` is its worker's environment — declare in `beforeAll`); `cli` is unmeasured.
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
| one adopter's `x test unit` (768 files), 22.6.2 default (isolated) | 14 (+parent) | 193 s | 13.1 GB |
| the same, 22.7 default (16 GB+ box), test DB on `reusableDatabase` | 3 | 90-93 s | 3.7-3.9 GB |
| the same, 2 workers (an 8 GB box's default) | 2 | 150 s | 2.6 GB |
| framework `x test unit` (1620 files), no isolation | 3 | 115-125 s | 2.9-3.0 GB |
| framework `bun run verify` (whole gate, `"isolate": true`) | 3 | 227 s | 3.4 GB |

The framework repository itself opts back into `"isolate": true`: its suites exercise the
process-global registries on purpose (fixture apps per test, empty permission sets), and without
isolation a handful of files fail depending on which worker ran what before them. Apps do not
need it — one adopter's unit, contract and job tiers pass without isolation.

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

21 steps, one list, in cost order. **The gate is this command with no flag** — "green" has to
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
| `exercise` | an action, query or job that never reached its handler when `x exercise` ran it once on generated rows (`X_CONTRACT_EXERCISE_UNREACHED`, its fix the override to paste); one that handed tenant B tenant A's data or changed A's row (`X_TENANT_LEAK`, `X_TENANT_WRITE_CROSSED`); a job that, killed at a step boundary, made an effect twice (`X_JOB_CRASH_DIVERGED`); a tenantless child of a tenant-owned table (`X_ENTITY_TENANT_UNDECLARED`) → [The exercise pass](#the-exercise-pass). Skipped in a repo with no `app.config.ts` |
| `e2e` | a real browser (raw CDP, no Playwright) against the app, spawned on a throwaway database, when Chrome is on the machine; otherwise its browser cases skip, or refuse under `E2E_BROWSER_REQUIRED=1` |
| `eval` | a prompt scoring below its committed baseline, or a prompt with no eval at all |
| `drift` | schema differs from migrations, or a migration is not reversible-or-marked |
| `contract-diff` | a breaking change to a published action/query without a version bump |
| `budgets` | per-route JS bytes; a live hook on a route with no island is `X_LIVE_ROUTE_NO_ISLAND` |
| `seo` | an indexable `site/` route with no title, or no description a search result can render |
| `i18n` | a key missing from a locale's catalog, or a catalog no module ever registered |
| `policy` | a permission this app grants or requires that it does not declare. Skipped — never passed — in a repo with no `app.config.ts` |
| `manifest` | `x.manifest.json` / `openapi.json` differ from what the code produces, `AGENTS.md` is missing or over its byte cap, or a job's `timeout` outlasts the worker's budget (`X_JOB_OUTLASTS_DRAIN`) |
| `roadmap` | framework repo only — a milestone missing its status marker, or a shipped milestone missing an artifact its own row names |

Any failure fails the gate; flakes are failures.

```text
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ filesize  ✓ package-shape  ✓ errors
  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ exercise  ✓ e2e  ✓ eval
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

**The declared numbers are a 4-core CI runner's.** `x verify` measures the machine once, before
any step — its cores against 4, a short single-threaded probe against the runner's — and multiplies
every declared deadline by that pace: each step's above, Bun's 5 s per test (`--timeout`), and a
test's own `{ timeoutMs }` or `paced(ms)` (`ULTIMATE_TEST_PACE`). A faster machine is pace 1, never
a tighter number. A number in `x.verify.json` is taken as written. `--json` carries the reading as
`data.pace` — `{ factor, cpus, probeMs }` — and a timed-out step whose deadline was stretched says
by how much.

**The gate says where it is.** In either render, one line per finished step on stderr —
`{"step":"lint","ok":true,"ms":21987}` — so a cancelled CI job's log ends on the last step that
finished, and a `still running: unit (12m 3s)` heartbeat every minute a step runs, so a harness
that kills on silence never kills a slow but healthy step. Under `--json` stdout stays the one document.

`x verify --json` emits the same content machine-readably → [MCP and AI](MCP-And-AI). CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check developers cannot run.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_SEALED` | a test reached the network without a mock | `mockFetch('<url>', …)`, or `allowHost('<host>')` if the call must be real — both from `@ultimat3/testing`. There is no `x test mock` subcommand |
| `X_FORBIDDEN` | the actor's policy refused — the assertion target of every denial test | `x actions show <action> --json` names the capability it enforces: assert the denial with `.rejects.toBeUltimateError('X_FORBIDDEN')`, or grant that capability to the seeded actor's role in `apps/web/shared/policies.ts` |
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
- Hunting an order flake: `x test unit --filter <file> -- --rerun-each=30 --randomize` — the `--` hands the rest to `bun test`.
- Every framework package ships at least 2 tests that would catch a real regression. No `expect(true).toBe(true)`.
- Tests live next to their source as `<file>.test.ts`.
- A denial test per policy branch, not one happy-path test per action.
- Every island declares its states, and the states worth declaring are the ones you cannot click to. What the pictures are then judged against: [Interface rules](Interface-Rules).
- Assert on error **codes**, never on error message text.
- CI runs `x verify` and nothing else.
