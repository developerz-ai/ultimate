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
| **Sealed network** | any egress not explicitly mocked **fails the test** with `X_TEST_NETWORK_SEALED`, naming the URL and the fix |
| **Fixed timezone + locale** | `UTC` and `en-US` unless a test declares otherwise; a tz-dependent bug fails deterministically |
| **Ordered concurrency** | job workers in tests run deterministically; `runJobs()` drains the queue synchronously |

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
| **e2e** | `x test e2e` | real browser against the built output: render mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload | built app + cloned DB |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

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
goes red because a machine has no Chrome fails for reasons unrelated to the change. The app
supplies the browser: `bun add -d puppeteer-core`, or `--cdp-url` to attach to one already running.

`As of 2026-09`.

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

`test` passes a bag as the first argument and builds only what the body destructures — a test that never names `runJobs` never starts a queue. The framework owns the whole bag; an app registers only what the framework cannot know.

| Fixture | Is | Built by |
|---|---|---|
| `clock` | `now()` · `advance('3d')` · `set(instant)` | the preload |
| `mail` | `outbox()` · `lastTo(address)` · `failOnce(mail)` | the preload |
| `network` | `offline()` · `drop()` · `online()` · `state()` | the preload |
| `runJobs` | enqueue+drain, then `drain()` `due()` `inFlight()` `depth()` | the preload |
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

| | |
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

## Generated scaffolds

Every primitive emits a test scaffold that fails until filled in — an untested action is a red build, not a backlog item.

| Primitive | Scaffold |
|---|---|
| `action` / `mutator` | schema round-trip + one denial case per policy branch |
| `query` (`live: true`) | snapshot + one incremental patch + one policy-filtered row |
| `job` | idempotency dedupe + one step-retry case |
| `route` | metadata presence, budget, and offline strategy |
| `llm` prompt | an evals file (missing evals fails `x verify`) |

## `x verify`

The single gate. Green means shippable.

Twenty steps, one list, in cost order. **The gate is this command with no flag** — "green" has to
mean the same thing for everyone. `x verify --only <step>` runs one step for an iteration loop and
says `NOT A GATE RUN` in the summary and in `--json` (`data.notAGateRun`), writing no floor file;
there is no `--skip`, because a knob that removes a step from a run still calling itself the gate is
the one thing this command must not offer. A step with nothing to check reports as skipped (`-`),
never as passed.

The list is defined once, as `VERIFY_STEP_NAMES` in
[`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts).
This table is a hand-synced copy of it ([Contributing](Contributing)).

| Step | Fails on |
|---|---|
| `typecheck` | any error; `any` is banned by lint, not tolerated by a cast |
| `lint` | biome only: formatting, `any`, default exports, unused imports. **Not** raw colours, bare `Error`, untranslated strings or unzoned dates — biome ignores `.scss` entirely and those four are guards, one row down |
| `boundaries` | `site/` → `app/`, routes → DB, services → HTTP, tier violations in framework packages, **and every file in the app's own `guards/`** — the nine `x new` writes, or the ones you kept → [Interface rules](Interface-Rules) |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, or `src/index.ts` |
| `errors` | an `X_*` code with no runnable fix or no docs page |
| `unit` | pure logic — services, money, policy predicates, matchers |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | the built output under Playwright, offline and SW update included |
| `eval` | a prompt scoring below its committed baseline, or a prompt with no eval at all |
| `drift` | schema differs from migrations, or a migration is not reversible-or-marked |
| `contract-diff` | a breaking change to a published action/query without a version bump |
| `budgets` | per-route JS bytes and LCP; a live hook on a route with no island is `X_LIVE_ROUTE_NO_ISLAND` |
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

`x verify --json` emits the same content machine-readably → [MCP and AI](MCP-And-AI). CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check developers cannot run.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_SEALED` | a test reached the network without a mock | `mockFetch('<url>', …)`, or `allowHost('<host>')` if the call must be real — both from `@ultimat3/testing`. There is no `x test mock` subcommand |
| `X_FORBIDDEN` | the actor's policy refused — the assertion target of every denial test | `x actions describe <action> --json` names the capability it enforces: assert the denial with `.rejects.toBeUltimateError('X_FORBIDDEN')`, or grant that capability to the seeded actor's role in `apps/web/shared/policies.ts` |
| `X_INVARIANT` | a domain invariant was violated inside a test fixture | fix the seed or the invariant |
| `X_CONFIG_INVALID` | test config names an unknown worker count, driver, or test type | `x test --help` |

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
