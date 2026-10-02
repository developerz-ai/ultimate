# Scraping

A scrape is a **`job`**, not a ninth primitive. `scrape()` returns a `JobHandle`, so it inherits `.enqueue()`, the retry policy, the worker's cancellation, the dead-letter path and `x jobs show` — the same factory shape `backfill()`, `llm()` and `agent()` use ([The eight primitives](The-Eight-Primitives)).

`As of 2026-10-01`: 53 source files, 32 owned `X_SCRAPE_*` codes, 2 borrowed. Zero runtime dependencies outside `@ultimat3/*` — puppeteer is **passed in**, never imported ([Drivers](#drivers)).

## What ships

| Capability | Mechanism |
|---|---|
| Browser automation | `ScrapePage`, driver-blind — the same body runs on a browser, a recording, or a string of HTML |
| The second transport | `http` on the same session: the browser's cookies, headers, proxy, host list, rate limit and cancellation |
| Actionability | waits for visible, enabled, unobstructed and **still** before acting — not for the selector alone |
| Host allow list | `intercept.ts`, one decision, asked by every driver and the HTTP leg, before a byte leaves |
| robots.txt | obeyed by default, on both legs, deadlined and capped |
| Rate limiting | navigations per second, across both legs. There is no unpaced mode |
| Secrets | declared by name, resolved in the worker, and a typed secret **refuses** later pixel captures |
| Sessions | capture, persist **sealed**, restore, validate, burn |
| One session per connection | `concurrency: { key, limit: 1, whenBusy: 'fail' }` — the job's own keyed cap |
| An exit per run | `egress: (input, ctx) => proxyUrl`, resolved in the worker — never carried in the queue payload — and dialled by both legs and the robots read |
| A rented browser | `remoteBrowser({ cdpUrl: resolver })` — acquired per session, released exactly once |
| A prompt answered mid-run | `eventPrompt({ timeout })` + `answerPrompt()`, over the stored job event bus, with the browser open |
| Usage on every result | `ScrapeReport.usage` — a measurement, never a quota |
| The silent-green alarm | `expect: { minRows, maxDrop }` — a scrape that returns nothing fails instead of succeeding |
| Offline testing | two drivers that never touch the network, pinned against the real one by a parity suite |
| Wedge watchdog | kills a browser that has gone silent, after a graceful quit |

## The declaration

```ts
export const dailyOrders = scrape({
  name: 'orders.daily',
  input: t.object({ page: t.number.int() }),
  extract: t.object({ id: t.string, title: t.string }),
  idempotencyKey: (input) => `orders:${input.page}`,
  tenant: (input) => input.orgId,
  allowHosts: ['shop.example'],
  expect: { minRows: 1 },
  async run({ page, http, step }) {
    await step.run('list', () => page.goto('https://shop.example/orders'));
    return (await page.values('.row')).map((row) => ({ id: row.attrs['data-id'], title: row.text }));
  },
});
```

| Field | Required | What it decides |
|---|---|---|
| `name` | yes | the durable queue key, never an export name |
| `input` | yes | the job's input schema |
| `extract` | yes | **every row, parsed.** A row the schema rejects is `X_SCRAPE_OUTPUT_INVALID`, never a stored partial |
| `idempotencyKey` | yes | derived from `input` alone, like every job's |
| `tenant` | yes | or `'none'` — a job runs with no request behind it, so an unscoped read would be unscoped for real |
| `allowHosts` | yes | `['*']` is legal and is a decision spelled out; `[]` is refused at declaration |
| `run` | yes | the body: `{ input, page, http, step, ctx, secrets }` |
| `block` | — | resource types to drop (`image`, `font`, …) |
| `rate` | — | navigations per second. Default `1`; `0` or negative is refused at declaration |
| `robots` | — | `'obey'` (default) or `{ ignore: '<reason>' }` — a reason is required |
| `expect` / `history` | — | the yield alarm, below |
| `secrets` | — | **names**, never values |
| `auth` / `prompt` | — | session lifecycle, and where an out-of-band code comes from — see [A session a service is built on](#a-session-a-service-is-built-on) |
| `egress` | — | `(input, ctx) => string \| undefined`, sync or async: the proxy URL THIS run leaves through, looked up in the worker. Wins over the driver's `proxy` |
| `onSettled` | — | how the run ended, told once: the `ScrapeReport` on `completed`, the `code` and the last attempt's `usage` otherwise — see [Usage](#usage) |
| `recover` | — | a hook, or `'agent'` — see [Recovery](#recovery) |
| `artifacts` | — | where a failed run's HTML is written: `{ storage: () => disk('artifacts') }` — a thunk, read per write |
| `driver` | — | which browser. Absent uses the process-wide `setScrapeDriver()` |
| `watchdog` | — | `{ idleMs, graceMs }`, defaults `120000` / `5000` |
| `retry` / `timeout` / `pageTimeout` / `queue` / `concurrency` | — | the job knobs, unchanged — `concurrency` takes the job's keyed form too ([Jobs and workflows](Jobs-And-Workflows)) |
| `clock` | — | pins this definition's clock. Absent uses the process's — `setScrapeClock()`, which is what a test replaces |

The CLI has no scrape command and no scrape generator `As of 2026-08-20` — `g` ships thirteen positionals and `scrape` is not one of them. A scrape is reached through the job CLI:

```bash
x jobs ls --name orders.daily --json
x jobs show <id> --json
x jobs retry <id> --from-step list --json
```

## The page vocabulary

One interface, three drivers, no driver type in it.

| Call | Notes |
|---|---|
| `goto(url, { timeout })` | refused before a byte leaves on a blocked host or a disallowed path |
| `waitFor(selector, { state, timeout })` | `attached` → `visible` → `enabled` → `actionable`; each implies the ones above |
| `click` / `type` / `fill` / `select` | every one waits for `actionable` first |
| `values` / `text` / `html` / `count` | reads; `text()` with no argument is the whole document |
| `evaluate(expression)` | returns `unknown` — parse it |
| `frame(nameOrSelector)` | re-resolves on every call; nothing hands out a stale handle |
| `screenshot` / `pdf` | `{ fullPage }` only |
| `download({ timeout })` | whatever the last click produced, or `X_SCRAPE_DOWNLOAD_TIMEOUT` |
| `cookies` / `session` | the handoff to the HTTP leg, as a value you can inspect |
| `query(selector)` | every match as a snapshot — tag, attributes, text, **and `visible`**. The one definition of "visible" in the framework; nothing else may compute it |
| `offline(enabled)` | the browser's own offline mode. **Not** `@ultimat3/testing`'s sealed network, which patches `fetch` in the *test process* and a browser's requests never traverse — a test built on that would pass against a fully online app |
| `focus(selector, { timeout })` | waits for `actionable`, then moves focus — the setup for a `press()` |
| `press(chord)` | `'Meta+K'`, `'Escape'`, `'Shift+Tab'` on whatever holds focus. Modifiers are `Meta`, `Control`, `Alt`, `Shift` in the browser's own spelling; `'Ctrl+K'` is `X_SCRAPE_KEY_INVALID` on **every** driver, offline included — the parse is the one thing an offline driver can be wrong about, so it runs there too, then stops |
| `accessibility(selector, { max })` | what a screen reader is told about each match — the browser's **computed** role and name, after ARIA and label association, at most `max` (default 25) nodes. Refused with `X_NOT_IMPLEMENTED` on the offline drivers and on a frame of the real one, never answered from `role=` on the tag: a `<div onclick>` computing no role *is* the finding |
| `console()` / `network()` | bounded rings, 200 entries each |
| `pageErrors()` / `pageErrorsDropped()` | uncaught exceptions, a **third** ring — not console lines |

**A frame verb acts on the frame, and this had to be fixed.** `frame()` returns a target that
overrides every verb addressing a document — `click`, `type`, `select`, `clear`, `query`. Until
2026-08-25 `clear` was missing from that list, so `frame(…).fill()` cleared the **parent's**
same-id field and then *appended* to the frame's: a remembered username submitted as
`oldUserNEWUSER` while a parent field was silently emptied. On the offline drivers one shared
overlay made it worse — `page.values('#password')` read back what was typed into the frame.

`driver-parity-frames.test.ts` pins every frame verb across all three drivers, because the parity
suite that exists to catch a CDP/offline divergence had no frame coverage at all.

`screenshot`/`pdf` take **no `timeout`** — `CaptureRequest.timeout` and the port's `CaptureOptions.timeoutMs` were deleted in 4.0.0 ([Upgrading](Upgrading)). No driver had ever honoured them, and a deadline enforced above the driver would have had to race `ScrapeClock.sleep`, which under `testClock` resolves on the first microtask — so every capture in every test would have timed out. The driver's own default is the honest bound.

**`pageErrors()` is a separate stream from `console()`, and that is not tidiness.** An uncaught
exception calls no console method, so a page whose script died can answer `console(): []` — gate on
console alone and it reads as clean. Nothing in this package observed `pageerror` before
2026-08-21: `console` and the renderer-crash `error` event were subscribed, and a throw fell between
them. The two events are also not interchangeable — `error` latches the crash flag, after which every
call answers `X_SCRAPE_PAGE_CRASHED`, which is classified **terminal**; routing a `pageerror` there
would dead-letter a scrape of a page that still renders perfectly.

A `PageError` carries `message`, an optional `stack` and `at`. **Keep the stack** — it names the
module and line that threw (`at Cart (/app/islands/cart.tsx:31:18)`), which is the difference between
a report and a lead; `message` alone says what went wrong and never where. It is truncated at
`MAX_PAGE_ERROR_CHARS` (4,000) and marked when it is, because one blown stack is thousands of frames.
An absent `stack` means the payload carried none — a `throw 'string'` — never that the throw had no
origin.

`pageErrorsDropped()` makes the count a **floor**: the ring is bounded, so `pageErrors().length` is
what survived eviction and not what happened.

`click` takes **no index**. It clicks the first match, on every driver.

## Two transports, one session

Drive the browser through login and navigation, then pull the bulk off the site's own JSON endpoints. `http.request()` carries the browser's cookies (scoped per RFC 6265 §5.1.3/§5.1.4), its headers, its proxy, the same `allowHosts`, the same robots gate, the same pacing and the same cancellation. A redirect is followed one hop at a time under the same gates — each `Location` is screened against `allowHosts` and robots, recorded in `page.network()` under the URL actually requested, and re-scoped for cookies — so a scraped endpoint cannot 302 the worker onto a host the allow list never named. A hop to another origin carries no credential you set (`authorization`, `proxy-authorization`, a hand-written `cookie`), and it stays dropped for the rest of the chain; a same-origin hop keeps them. A `301`/`302` re-asks a `POST` as a `GET` and leaves every other method — a `PUT` or a `DELETE` — intact with its body, `303` re-asks everything but `GET`/`HEAD`, and `307`/`308` carry both. `res.url` is the final URL, a chain past `MAX_REDIRECT_HOPS` (10) is `X_SCRAPE_REDIRECT_LOOP`, and a `javascript:` URL is refused outright rather than read as a hostless scheme.

Two hundred paginated pages clicked through is minutes and two hundred chances to break; the same data off the endpoint behind them is seconds, and a JSON endpoint changes far less often than a DOM.

Response bodies are counted **as they arrive**, capped at `DEFAULT_HTTP_MAX_BYTES` (32 MiB) — `.text()` on a hostile stream is a heap the worker never gets back.

## Drivers

| Driver | Use | Network |
|---|---|---|
| `localBrowser({ launcher, executablePath })` | a browser in this container | real |
| `remoteBrowser({ launcher, cdpUrl })` | an attached CDP endpoint — a fixed URL, or a `CdpResolver` that rents one per session | real |
| `fixtureBrowser(dir)` | committed page recordings | none |
| `fakeBrowser(pages)` | inline pages, for a unit test | none |

**The launcher is passed in, never imported.** `CdpLauncherLike` is two methods — `launch` and `connect` — so `puppeteer`, `puppeteer-core` or anything with the same shape satisfies it, and this package declares no browser dependency at all. A launcher with no `launch` is `X_SCRAPE_REMOTE_REQUIRED`, not a crash.

`driver-parity.test.ts` runs one suite against all three and pins the single honest divergence: the offline drivers have no layout engine, so `ElementSnapshot.box` and `hitTarget` are absent rather than faked.

## The silent-green alarm

A scraper that returns zero rows because the site changed its markup is the failure that does not look like one.

```ts
expect: { minRows: 1, maxDrop: 0.5, window: 7 },
history: yourYieldHistory,
```

| Rule | Needs `history` | Fires when |
|---|---|---|
| `minRows` | no | the run returned fewer rows than the floor |
| `maxDrop` | **yes** | the run fell more than this fraction below the trailing median |

`minRows` is an absolute floor, checked **before** the history gate, so it is legal on its own. `maxDrop` is a fraction of a trailing median and only a `history:` store can supply one — declaring it alone is refused at declaration with `X_SCRAPE_YIELD_HISTORY_MISSING`, because with no store the baseline is `[]` forever and the alarm could never fire.

A collapsed run is **not recorded**. Three broken runs at 2 rows would make the median 2, and the fourth broken run would be within `maxDrop` of it — a scraper that re-baselines onto its own failure has silenced the alarm exactly when it was working. `maxDrop` needs `MIN_BASELINE_RUNS` (3) runs after it is declared before it can fire: a delay, not a hole.

## Robots, hosts, rate

| Gate | Default | Refusal |
|---|---|---|
| `allowHosts` | required, no default | `X_SCRAPE_HOST_BLOCKED`, before a byte leaves |
| `robots` | `'obey'` | `X_SCRAPE_ROBOTS_DISALLOWED` |
| `rate` | 1 navigation/second | none — it paces, across both legs |

Ignoring robots takes a written reason: `robots: { ignore: 'contract with the operator, ticket OPS-441' }`. A bare `false` is a decision with no author.

The `/robots.txt` read is deadlined (10s), capped (500 KiB) and dialled through the session's own exit — the run's `egress`, else the driver's `proxy` — asked per read, because the exit is resolved inside `driver.open()` while the gate is an argument to it. An offline driver reports the run's `egress` too, so its one real request leaves the same way. An unreadable robots.txt reads as **no restrictions**, which is the standard's own answer and the reason the deadline matters.

Robots patterns are **walked**, not compiled — a wildcard-dense rule from a scraped site is linear rather than catastrophic backtracking on the worker's only thread.

## Secrets

Declared by name, resolved in the worker, never in the definition:

```ts
secrets: ['SHOP_PASSWORD'],
run: async ({ page, secrets }) => {
  await page.type('#password', secrets.get('SHOP_PASSWORD'));
}
```

**Redaction is by VALUE, on four surfaces**: `page.html()`, `page.console()`, `page.network()` URLs
and `page.pageErrors()` — plus the HTTP leg's response body, which reaches an error `cause` and
from there a dead-letter row that `x jobs show` prints. Three of those were unredacted until
2026-08-25 while this package's own header promised all of them.

**One stated limit**: a secret shorter than 4 characters is not redacted. A 3-character token would
match too much ordinary page text to be safe to blank; declare a longer one.

Typing a `Secret` **taints the page**. A later `screenshot()` or `pdf()` is refused with `X_SCRAPE_SECRET_EXPOSED` — a screenshot of a filled login form *is* the password, in pixels, in object storage, forever. Refused rather than masked: a mask over pixels is a guess about layout, and `page.html()` already gives a redacted artifact that is exact.

## Sessions

Reuse is both the fast path and the safe path — logging in on every run is slow and is itself the signal anti-bot systems look for.

| Call | What it does |
|---|---|
| `restorableSession(plan)` | the stored session this run may restore, or `undefined` |
| `ensureAuthenticated(plan)` | log in when there is nothing to restore |
| `burnSession(plan)` | delete it — a flagged profile stays flagged, so a retry that reloads it re-trips the block |
| `memorySessionStore()` / `storageSessionStore(() => disk('sessions'))` | where it lives. The disk is a THUNK, read per call: a scrape is declared when its module loads, and the app's disks exist only after boot ran `defineStorage()` |

**A stored session is sealed.** `storageSessionStore` writes `{ "sealed": "x1.…" }` — core's
`seal()` under the app's master key (`x secrets init`), purpose `scrape-session`. No cookie value,
`localStorage` token or origin is readable from the bucket.

| Found on `load()` | Answer |
|---|---|
| this store's sealed record, saved under this key | the session |
| nothing | `undefined` — the run logs in |
| an unsealed object, a corrupt one, one sealed under a key this process does not declare, one copied from another key's path | **burned**, then `undefined` — a session is a cache, so nothing is migrated |
| no master key at all | `X_SEAL_KEY_MISSING`, before the browser opens — run `x secrets init` |

**Upgrading into sealed sessions discards what was stored before**, refusal markers included. A
record written before sealing shipped (23.0.0) is unsealed, so its first `load()` burns it: the run
logs in again, and a credential the site had already refused is presented once more instead of
being refused before the browser opens. On a site that locks an account after repeated failures,
correct that credential before the first run after upgrading
([Upgrading](Upgrading), `22.x → 23.0.0`).

**The key hashes each segment, and this changed on 2026-08-25.** A session key is
`<tenant>/s/<discriminator>`, and both segments used to be sanitised by collapsing every run of
non-`[a-zA-Z0-9._-]` to a single `-`. So `alice@corp.com` and `alice-corp.com` produced **one key**,
as did `acct/1` and `acct-1`, and tenants `acme corp` and `acme-corp`. The browser then loaded
account A's cookies, `auth.validate()` answered `true` — the session *is* valid, for the wrong
account — and A's rows were stored under B's tenant. Each segment now carries a hash of its raw
value, so two spellings can no longer collide.

**Migration: none to run.** Every stored key changes spelling, a miss reads as "no session", so the
run logs in again and writes the new key. One extra login per stored session, no error, and the old
objects are orphaned until the bucket's lifecycle rule collects them.

A session record survives a **refusal** rather than being deleted with it: `refusedAt` is read before `driver.open()`, so a replay, a manual `x jobs retry` or a second enqueue refuses without spending a browser, a CDP attach or one more wrong password at a site that locks accounts after three.

`parseSessionState` **completes** a stored cookie rather than asserting it. A jar entry carrying only `name` and `value` gets `domain: ''`, `path: '/'`, `httpOnly: false`, `secure: false`. An empty domain matches **no host** — inferring one from whichever URL is asking is exactly how a `bank.test` session cookie reaches `evilbank.test`. Before 4.0.0 the parser claimed such an entry was a whole `ScrapeCookie` and `cookieHeaderFor` then threw a bare `TypeError` on `domain.trim()`.

Session material is credential material: it is tenant-scoped, it never reaches a log line, an event field, an artifact or a screenshot, and `sessionDigest()` summarises it as counts and an origin.

## A session a service is built on

One declaration: a caller opens a session, events stream out, input goes in mid-run, one result
comes back. Every piece is a field on `scrape()` or on its driver.

```ts
const rent: CdpResolver = async ({ runId, egress, signal }) => {
  const rented = await provider.create({ tag: runId, proxy: egress, signal });
  return {
    cdpUrl: rented.connectUrl,
    release: () => provider.end(rented.id),
    cost: { minor: rented.priceCents, currency: 'USD' },
  };
};

export const syncAccounts = scrape({
  name: 'accounts.sync',
  // Ids only: the input is the queue row, and a proxy URL carries its account.
  input: t.object({ connectionId: t.uuid, orgId: t.uuid }),
  extract: t.object({ id: t.string }),
  idempotencyKey: ({ connectionId }) => `accounts:${connectionId}`,
  tenant: ({ orgId }) => orgId,
  allowHosts: ['bank.example'],
  driver: remoteBrowser({ launcher: puppeteer, cdpUrl: rent }),
  // Resolved in the worker, under the job's tenant — a `.sealed()` column on the connection row.
  egress: async ({ connectionId }) => (await connections.byId(connectionId))?.exit,
  concurrency: { key: ({ connectionId }) => connectionId, limit: 1, whenBusy: 'fail' },
  auth: {
    store: storageSessionStore(() => disk('sessions')),
    key: ({ connectionId }) => connectionId,
    login,
  },
  prompt: eventPrompt({ timeout: 300_000 }),
  run,
  // How the run ended: the report with its usage, or the code it failed with.
  async onSettled(settled) {
    if (settled.input === undefined) return;
    await runs.record(settled.runId, settled.outcome === 'completed' ? settled.result.usage : settled.usage);
  },
});
```

| Field | Rule |
|---|---|
| `egress` | the run's exit, resolved in the WORKER: `(input, ctx)`, sync or async, under the job's tenant. The input names a row; the row holds the exit. An exit whose password is also in the input rode the queue payload — `x_jobs` holds it in the clear, and `redactInput` hides a key by name for display only — so it is refused before the browser opens: `X_SCRAPE_EGRESS_IN_PAYLOAD`, terminal. Both legs dial it and the robots read leaves through it. Credentials in the URL never reach the process arguments — a launched browser answers the proxy through `page.authenticate()` — and are redacted by value everywhere |
| `cdpUrl: resolver` | called once per `open()` with `{ scrape, runId, egress, signal }`. `release()` runs **exactly once**: in the session's `close()` after the browser is quit — on success, failure and cancellation — and straight away when the attach itself fails. The framework ships no vendor |
| `cdpUrl: 'ws://…'` + `egress` | `X_SCRAPE_EGRESS_UNSUPPORTED` when the exits differ: a fixed URL is a browser already bound to one |
| `concurrency: { key, limit, whenBusy }` | the job's field. `whenBusy: 'fail'` settles a second run of one connection `failed` with `X_JOB_KEY_BUSY`, body never run |
| `auth.store` | the declaration that persists a session. Absent means every run logs in. `auth.login` and `auth.validate` are handed `runId` beside `input` |
| `prompt: eventPrompt({ timeout })` | below |

### A prompt answered while the browser stays open

`eventPrompt({ timeout, pollMs? })` polls the job event bus **in process**. It is not
`step.waitForEvent`: that suspends the run and closes the browser the site is waiting in.

The bus must be the **stored** one (`EventBus.stored`): the answer is published by a web process and read by the worker. Outside development and test, an in-memory bus is refused when the prompt is asked — `X_DRIVER_UNAVAILABLE`, fix `setEventBus(createPgEventBus({ executor }))` — rather than timing out minutes later as `X_SCRAPE_PROMPT_UNANSWERED`.

| Fact | Detail |
|---|---|
| event name | derived, never chosen: `promptEventName(runId, index)` → `scrape-prompt:<runId>:<n>`, `n` from 1 per attempt. `PromptRequest` carries both, and the run's `input` — what a handler ties the prompt to in the app's own tables |
| answering | `answerPrompt({ runId, index, answer })` from the app's own action. The name is **not** an authorization — the action's `policy` is |
| on the bus | the answer is **sealed** for that one event name and expires in 10 minutes (`ttl`). A payload `answerPrompt()` did not write is refused, never typed |
| stale answers | only an answer published **after** the prompt was asked is consumed — the run id is the same on every attempt |
| while it waits | the worker's heartbeat keeps the claim; one browser round trip per poll keeps the wedge watchdog and a rented browser alive |
| it ends on | the answer · `timeout` → `X_SCRAPE_PROMPT_UNANSWERED` (terminal) · the run's `signal` · a browser that died |
| the bus | must be the **stored** one (`createPgEventBus`) wherever the worker and the answering process differ. Every `x` boot installs it; a hand-written boot calls `setEventBus(createPgEventBus({ executor }))` |

Saying a prompt is pending is the app's — wrap the handler, it is a function:

```ts
const waitForAnswer = eventPrompt({ timeout: 300_000 });
// on the definition:
prompt: async (request) => {
  await runEvents.insert({ runId: request.runId, index: request.index, label: request.label });
  return waitForAnswer(request);
},
```

### Usage

`ScrapeReport.usage`, and the same counts on the `scrape.ok` / `scrape.failed` log lines.

| Field | Counts |
|---|---|
| `browserMs` | from before `driver.open()` to the report, on the run's clock |
| `navigations` | `page.goto()` calls that reached the driver — a refused host is not one |
| `httpRequests` | requests the HTTP leg put on the wire, one per redirect hop |
| `bytesIn` | response-body bytes the **HTTP leg** read. The browser leg's traffic is not measured |
| `promptsAnswered` | prompts a handler answered |
| `browserCost` | the resolver's `cost`, a `Money` (`{ minor, currency, scale? }`) — a float is `X_VALIDATION_FAILED`. Absent when nothing was rented |

No quota, plan or ledger reads these numbers. What a number is worth is the app's.

**Reaching the app.** A worker hands a job's return value to one place: the job's `onSettled`
([Jobs and workflows](Jobs-And-Workflows)). A scrape's adds what is scrape-specific.

| `settled.outcome` | Carries |
|---|---|
| `completed` | `result` — the whole `ScrapeReport`: `rows`, `artifacts`, `usage` |
| `dead-lettered` / `dropped` | `error`, `code`, and `usage`: what the last attempt used. A failed run has no report and was billed all the same |
| `refused` | `code: 'X_JOB_KEY_BUSY'`; `usage` is `undefined` — the body never ran |

After the row is settled, under the job's tenant, **at most once** across a crash; a hook that
throws is `X_JOB_ON_SETTLED_FAILED` and changes nothing. `run({ progress })` is the job's own
`progress(done, total, note?)`, passed through.

### A test's clock

```ts
import { noWaitClock, resetScrapeClock, setScrapeClock } from '@ultimat3/scraping';

beforeEach(() => setScrapeClock(noWaitClock));
afterEach(() => resetScrapeClock());
```

| Clock | Sleeping | For |
|---|---|---|
| `noWaitClock` | one turn of the event loop; `now()` and deadlines are real | a run that waits on something the test does — an answer it publishes, a second run it starts |
| `testClock()` | advances virtual time | a test OF a timeout |

A run waits on the process's clock unless its definition pins one, so the declaration under test
carries no `clock:` written for the test's sake.

### What never reaches a log, an error or an artifact

A prompt answer, the password of an `egress` URL and every credential-bearing part of a CDP URL are
added to the run's redaction set — `secrets.conceal(value)`, which a run body may call too.
`X_SCRAPE_CDP_ATTACH_FAILED` names **scheme and host only**, for a fixed URL as for a resolved one:
a provider's connect URL is its access token.

## Recovery

```ts
recover: async ({ page, failure, attempt }) => { /* return true to re-run the body once */ }
```

`recover: 'agent'` is **declared and not implemented** `As of 2026-08-20`. It throws `X_NOT_IMPLEMENTED` rather than answering `false`, because a recovery that silently declines is indistinguishable from one that was never configured. A hook that answers anything other than a boolean is `X_SCRAPE_RECOVER_REFUSED`.

## Error codes

32 owned codes, split by whether the same request can succeed unchanged. `x errors explain <CODE> --json` prints the cause, a runnable fix and the docs URL for any of them ([Error codes](Error-Codes)).

| Retryable | Why |
|---|---|
| `X_SCRAPE_CDP_ATTACH_FAILED`, `X_SCRAPE_BROWSER_UNREACHABLE`, `X_SCRAPE_BROWSER_MISSING` | the browser, not the page |
| `X_SCRAPE_TIMEOUT`, `X_SCRAPE_WEDGED`, `X_SCRAPE_DOWNLOAD_TIMEOUT` | a moment, not a property of the site |
| `X_SCRAPE_HTTP_FAILED` | 408, 409, 425, 429, any 5xx, a deploy — transient far more often than not. **Which 4xx are permanent is `@ultimat3/core`'s `isRetryableStatus`, not this package's**, `As of 2026-08-23`: a private copy here called 408 and 425 terminal while the rest of the framework called them retryable, and a terminal classification dead-letters the run on the attempt that failed rather than spending its declared `attempts` |
| `X_SCRAPE_BLOCKED` | retryable **and it burns the session first**: retrying a block on the same flagged cookies re-trips it every time |

Everything else is terminal, including `X_SCRAPE_SELECTOR_MISSING` (the markup changed), `X_SCRAPE_OUTPUT_INVALID` (the rows are the wrong shape), `X_SCRAPE_YIELD_COLLAPSED`, `X_SCRAPE_SECRET_EXPOSED`, `X_SCRAPE_KEY_INVALID` (the chord is the caller's own literal), `X_SCRAPE_PROMPT_UNANSWERED` and `X_SCRAPE_EGRESS_UNSUPPORTED` (the exit is the run's input and the driver is the deploy's constant).

## Testing offline

`fakeBrowser` and `fixtureBrowser` never touch the network. An unrecorded page or request **throws** rather than falling through, so a green suite cannot be secretly live.

**One request escapes that, and it is the robots read.** Under the default `robots: 'obey'`, an offline driver still fires a real `fetch` at `https://<host>/robots.txt` before the first navigation — the gate is built in `scrape-run.ts` and knows nothing about which driver `open()` will return. Measured again `As of 2026-08-20`: one egress per origin per run. Under `bun test` the sealed network's refusal is swallowed by the fetcher's `catch`, which the gate reads as "no restrictions" — green either way, which is the whole problem. Declare `robots: { ignore: 'offline fixture' }` on an offline scrape until it is closed → [Known gaps](Known-Gaps).

## What it does not do

| Not shipped | Detail |
|---|---|
| `recover: 'agent'` | throws `X_NOT_IMPLEMENTED` |
| Browser-leg bytes in `usage.bytesIn` | the CDP port subscribes to requests, not to their sizes. `bytesIn` is the HTTP leg alone |
| Usage on a FAILED run's result | a failed run has no report. Its counts are on the `scrape.failed` log line |
| A vendor | no browser provider, proxy inventory, captcha or OTP relay. `CdpResolver`, `egress` and `PromptHandler` are the seams |
| A capture deadline | deleted in 4.0.0; the driver's own default is the bound |
| CAPTCHA solving, fingerprint evasion, proxy rotation | none of it. `X_SCRAPE_BLOCKED` burns the session and re-raises |
| A scaffold | `g` has no `scrape` positional; write the declaration by hand |
