# Scraping

A scrape is a **`job`**, not a ninth primitive. `scrape()` returns a `JobHandle`, so it inherits `.enqueue()`, the retry policy, the worker's cancellation, the dead-letter path and `x jobs show` — the same factory shape `backfill()`, `llm()` and `agent()` use ([The eight primitives](The-Eight-Primitives)).

`As of 2026-08-20`: 41 source files, 26 owned `X_SCRAPE_*` codes, 2 borrowed. Zero runtime dependencies outside `@ultimat3/*` — puppeteer is **passed in**, never imported ([Drivers](#drivers)).

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
| Sessions | capture, persist, restore, validate, burn |
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
| `auth` / `prompt` | — | session lifecycle, and where an out-of-band code comes from |
| `recover` | — | a hook, or `'agent'` — see [Recovery](#recovery) |
| `artifacts` | — | where a failed run's HTML is written |
| `driver` | — | which browser. Absent uses the process-wide `setScrapeDriver()` |
| `watchdog` | — | `{ idleMs, graceMs }`, defaults `120000` / `5000` |
| `retry` / `timeout` / `pageTimeout` / `queue` / `concurrency` / `clock` | — | the job knobs, unchanged |

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
| `console()` / `network()` | bounded rings, 200 entries each |

`screenshot`/`pdf` take **no `timeout`** — `CaptureRequest.timeout` and the port's `CaptureOptions.timeoutMs` were deleted in 4.0.0 ([Upgrading](Upgrading)). No driver had ever honoured them, and a deadline enforced above the driver would have had to race `ScrapeClock.sleep`, which under `testClock` resolves on the first microtask — so every capture in every test would have timed out. The driver's own default is the honest bound.

`click` takes **no index**. It clicks the first match, on every driver.

## Two transports, one session

Drive the browser through login and navigation, then pull the bulk off the site's own JSON endpoints. `http.request()` carries the browser's cookies (scoped per RFC 6265 §5.1.3/§5.1.4), its headers, its proxy, the same `allowHosts`, the same robots gate, the same pacing and the same cancellation.

Two hundred paginated pages clicked through is minutes and two hundred chances to break; the same data off the endpoint behind them is seconds, and a JSON endpoint changes far less often than a DOM.

Response bodies are counted **as they arrive**, capped at `DEFAULT_HTTP_MAX_BYTES` (32 MiB) — `.text()` on a hostile stream is a heap the worker never gets back.

## Drivers

| Driver | Use | Network |
|---|---|---|
| `localBrowser({ launcher, executablePath })` | a browser in this container | real |
| `remoteBrowser({ launcher, cdpUrl })` | an attached CDP endpoint | real |
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

The `/robots.txt` read is deadlined (10s), capped (500 KiB) and dialled through the session's own proxy — asked per read, because the exit is resolved inside `driver.open()` while the gate is an argument to it. An unreadable robots.txt reads as **no restrictions**, which is the standard's own answer and the reason the deadline matters.

Robots patterns are **walked**, not compiled — a wildcard-dense rule from a scraped site is linear rather than catastrophic backtracking on the worker's only thread.

## Secrets

Declared by name, resolved in the worker, never in the definition:

```ts
secrets: ['SHOP_PASSWORD'],
run: async ({ page, secrets }) => {
  await page.type('#password', secrets.get('SHOP_PASSWORD'));
}
```

Typing a `Secret` **taints the page**. A later `screenshot()` or `pdf()` is refused with `X_SCRAPE_SECRET_EXPOSED` — a screenshot of a filled login form *is* the password, in pixels, in object storage, forever. Refused rather than masked: a mask over pixels is a guess about layout, and `page.html()` already gives a redacted artifact that is exact.

## Sessions

Reuse is both the fast path and the safe path — logging in on every run is slow and is itself the signal anti-bot systems look for.

| Call | What it does |
|---|---|
| `restorableSession(plan)` | the stored session this run may restore, or `undefined` |
| `ensureAuthenticated(plan)` | log in when there is nothing to restore |
| `burnSession(plan)` | delete it — a flagged profile stays flagged, so a retry that reloads it re-trips the block |
| `memorySessionStore()` / `storageSessionStore(storage)` | where it lives |

A session record survives a **refusal** rather than being deleted with it: `refusedAt` is read before `driver.open()`, so a replay, a manual `x jobs retry` or a second enqueue refuses without spending a browser, a CDP attach or one more wrong password at a site that locks accounts after three.

`parseSessionState` **completes** a stored cookie rather than asserting it. A jar entry carrying only `name` and `value` gets `domain: ''`, `path: '/'`, `httpOnly: false`, `secure: false`. An empty domain matches **no host** — inferring one from whichever URL is asking is exactly how a `bank.test` session cookie reaches `evilbank.test`. Before 4.0.0 the parser claimed such an entry was a whole `ScrapeCookie` and `cookieHeaderFor` then threw a bare `TypeError` on `domain.trim()`.

Session material is credential material: it is tenant-scoped, it never reaches a log line, an event field, an artifact or a screenshot, and `sessionDigest()` summarises it as counts and an origin.

## Recovery

```ts
recover: async ({ page, failure, attempt }) => { /* return true to re-run the body once */ }
```

`recover: 'agent'` is **declared and not implemented** `As of 2026-08-20`. It throws `X_NOT_IMPLEMENTED` rather than answering `false`, because a recovery that silently declines is indistinguishable from one that was never configured. A hook that answers anything other than a boolean is `X_SCRAPE_RECOVER_REFUSED`.

## Error codes

26 owned codes, split by whether the same request can succeed unchanged. `x errors explain <CODE> --json` prints the cause, a runnable fix and the docs URL for any of them ([Error codes](Error-Codes)).

| Retryable | Why |
|---|---|
| `X_SCRAPE_CDP_ATTACH_FAILED`, `X_SCRAPE_BROWSER_UNREACHABLE` | the browser, not the page |
| `X_SCRAPE_TIMEOUT`, `X_SCRAPE_WEDGED`, `X_SCRAPE_DOWNLOAD_TIMEOUT` | a moment, not a property of the site |
| `X_SCRAPE_HTTP_FAILED` | 429, 502, a deploy — transient far more often than not |
| `X_SCRAPE_BLOCKED` | retryable **and it burns the session first**: retrying a block on the same flagged cookies re-trips it every time |

Everything else is terminal, including `X_SCRAPE_SELECTOR_MISSING` (the markup changed), `X_SCRAPE_OUTPUT_INVALID` (the rows are the wrong shape), `X_SCRAPE_YIELD_COLLAPSED` and `X_SCRAPE_SECRET_EXPOSED`.

## Testing offline

`fakeBrowser` and `fixtureBrowser` never touch the network. An unrecorded page or request **throws** rather than falling through, so a green suite cannot be secretly live.

**One request escapes that, and it is the robots read.** Under the default `robots: 'obey'`, an offline driver still fires a real `fetch` at `https://<host>/robots.txt` before the first navigation — the gate is built in `scrape-run.ts` and knows nothing about which driver `open()` will return. Measured again `As of 2026-08-20`: one egress per origin per run. Under `bun test` the sealed network's refusal is swallowed by the fetcher's `catch`, which the gate reads as "no restrictions" — green either way, which is the whole problem. Declare `robots: { ignore: 'offline fixture' }` on an offline scrape until it is closed → [Known gaps](Known-Gaps).

## What it does not do

| Not shipped | Detail |
|---|---|
| `recover: 'agent'` | throws `X_NOT_IMPLEMENTED` |
| `SessionInit.proxy` | declared, written by nothing, read by nothing. Pass `localBrowser({ proxy })` and read `ScrapeSession.proxy` back → [Known gaps](Known-Gaps) |
| A capture deadline | deleted in 4.0.0; the driver's own default is the bound |
| CAPTCHA solving, fingerprint evasion, proxy rotation | none of it. `X_SCRAPE_BLOCKED` burns the session and re-raises |
| A scaffold | `g` has no `scrape` positional; write the declaration by hand |
