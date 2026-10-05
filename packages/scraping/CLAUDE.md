# @ultimat3/scraping — boundary

Tier 5. May import tiers 0-4. Never sideways, never upward.

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *` — and complete enough that a third party implements `ScrapeDriver` from it alone. A driver author needing a deep import means the seam is not a seam |
| Errors | `src/errors.ts` owns the codes and their **retry classification**; `src/error-throws.ts` owns one constructor per failure mode, `src/error-throws-session.ts` the session ones (the first file is at its size ceiling) |
| Files | one responsibility each, tests beside the source |
| Dependencies | `@ultimat3/core`, `@ultimat3/jobs`, `@ultimat3/schema`, `@ultimat3/storage`. **No third-party runtime dependency at all** |
| Opt-in suite | `session.job.test.ts` — the pg driver and the stored event bus on a real Postgres (`TEST_DATABASE_URL`, its own database), a second OS process publishing the answer. Skips without the env. No `@ultimat3/db` here, so its `PgExecutor` is `Bun.SQL` with `prepare: false` and a hand-written array literal |

Commands: `bun test packages/scraping` from the repo root, `bunx tsc --noEmit -p tsconfig.json`.

Public docs: [`wiki/Scraping.md`](../../wiki/Scraping.md) — the only public surface. A capability this file
claims and that page does not carry is a capability an app author cannot find.

## Tier 5, and why not lower

`jobs` is tier 3 and `storage` is tier 1, so today's imports would allow tier 4. It sits at 5
because `recover: 'agent'` is designed to import `@ultimat3/ai` (tier 4), and a package at 4 cannot
import a package at 4. Moving up later would be a table change with consumers already attached.

Nothing in the framework imports it (`x shot` left in 22.0.0), so no sideways edge exists.

## puppeteer-core is NOT a dependency

`docs/idea/18-build-vs-wrap.md` permits a library at a driver/transport seam only. This package
goes one step further and takes **no** dependency: `cdp-port.ts` declares the library's shape
structurally, and the app passes its own `puppeteer` in (`localBrowser({ launcher: puppeteer })`)
— the same shape as `s3Driver({ client })` taking an `S3ClientLike`.

Verified `As of 2026-08` on **Bun 1.3.14 with puppeteer-core 25.8.0 against headless Chrome 150**:
both `launch()` and `connect({ browserWSEndpoint })` work, including the WebSocket upgrade that
Playwright's `connectOverCDP` cannot perform under Bun (oven-sh/bun#9911) — which is why puppeteer
is the intended library and Playwright is not.

**No puppeteer type may appear outside `cdp-port.ts`, `cdp-target.ts`, `cdp-snapshot.ts`,
`cdp-fake.ts` and `driver-cdp.ts`.** `ScrapePage`, `ScrapeTarget` and `ScrapeDriver` are the
vocabulary, and a `Page`, `ElementHandle` or `CDPSession` reaching them makes the seam decorative.

## NEVER `mock.module('puppeteer-core')`

Observed failure: `mock.module` replaces the module for the whole run, `bun test` does not fully
serialise test files, and a mock installed in one file leaked into a concurrently-running file's
assertions. Use the **injected launcher** instead — `cdp-fake.ts`'s `fakeCdpLauncher()` is a value,
and a value cannot leak. `driver-parity.test.ts` runs the real driver's code path through it.

## The rules this package enforces on itself

| Rule | Enforced by |
|---|---|
| no wait outside `clock.ts` | `clock-discipline.test.ts` scans `src/*.ts` for `setTimeout`/`setInterval`/`Bun.sleep`. `http.ts` and `robots-fetch.ts` are pinned as the exceptions — the two files that dial the platform's `fetch`, each for one `AbortSignal.timeout` handed to it. The exemption covers `AbortSignal.timeout` only; a real timer in either still offends |
| the fake never drifts from the real driver | `driver-parity.test.ts` runs one suite against `fake`, `fixture` and the puppeteer path, and pins the one honest divergence (no layout engine offline, so no box and no hit-target) |
| an unrecorded request throws | `html-target.ts` and `http-recorded.ts`. **One request escapes: the robots read.** Offline drivers under the default `robots: 'obey'` fire a real `fetch` for `/robots.txt` (the gate is built in `scrape-run.ts`, blind to the driver), and under `bun test` the sealed network refuses it: unreachable, so `X_SCRAPE_ROBOTS_DISALLOWED`. Declare `robots: { ignore: '<reason>' }` on an offline scrape → `wiki/Known-Gaps.md` |
| `allowHosts` is enforced, never advisory | `intercept.ts` is the single decision, asked by every driver AND by the HTTP leg, before a byte leaves. The CDP driver asks it at the BROWSER too (`armBrowser`: `Fetch` on `browser.target()`), so a popup is screened (`cdp-arm-targets.test.ts`). A wildcard-admitted name is resolved and pinned on the HTTP leg and robots read (`pinned-host.ts`). Open: Chrome's DNS, WebSockets (`wiki/Known-Gaps.md`) |
| a REDIRECT is a request nobody screened, so this leg follows it itself | `http.ts` sends `redirect: 'manual'` and walks the chain hop by hop (`http-redirect.ts`), re-asking `interceptVerdict`, `RobotsGate.assertAllowed`, `pace` and `cookieHeaderFor` for **every** hop, bounded by `MAX_REDIRECT_HOPS` (`X_SCRAPE_REDIRECT_LOOP`, terminal); `responseOver` and the ring carry the FINAL url. It re-performs the platform's two halves: a caller's credential (`authorization`, `proxy-authorization`, a hand-written `cookie`) is dropped at the first cross-origin hop and stays dropped, and only a `POST` is rewritten on `301`/`302` (`http-redirect-follow.test.ts`, `http-redirect.test.ts`) |
| a `javascript:` URL is refused, not treated as hostless | `hosts.ts`'s `REFUSED_SCHEMES`. It executes in the current origin, and `javascript://api.test/%0a…` parses with hostname `api.test`, so an allow list would have matched it (`hosts.test.ts`) |
| the robots read is deadlined, capped and screened | `robots-fetch.ts` is the ONE default `/robots.txt` read: `redirect: 'manual'`, each hop asked of `allowHosts` (`MAX_ROBOTS_REDIRECTS`), with `DEFAULT_ROBOTS_TIMEOUT_MS`, `DEFAULT_ROBOTS_MAX_BYTES` and the session's proxy — a RESOLVER read from `ScrapeSession.proxy`, because the exit is resolved inside `driver.open()`, after the gate is built. `scrape-run.ts` supplies the page timeout and `ctx.signal`: the gate caches one promise per origin (`robots-fetch.test.ts`, `scrape-run.test.ts`, `driver-cdp.test.ts`) |
| the exit is the RUN's, and a driver that cannot dial it refuses | `scrape({ egress })` → `SessionInit.proxy`, which wins over a driver's own `proxy`. `driver-cdp.ts`'s `exitFor()` is the one precedence; the session REPORTS it (offline ones too, so the robots read leaves through it). A fixed `cdpUrl` handed a different exit, or a credentialed exit on a launcher with no `page.authenticate()`, is `X_SCRAPE_EGRESS_UNSUPPORTED` (terminal) — never a silent dial of the driver's constant. Credentials never reach `--proxy-server`, which `launch-args.ts` appends AFTER the caller's args; a caller proxy switch is `X_SCRAPE_LAUNCH_ARGS_INVALID` (`egress.test.ts`) |
| the exit is resolved in the WORKER, and a credential that rode the payload is refused | `egress(input, ctx)` is awaited in `runScrape` under the job's tenant. `credentialInPayload()` reads the exit's password against the run's own input — through `secret-scan.ts`'s `containsSecret`, every window compared whole, never `.includes(password)` (`bun run secret-compare`); a hit is `X_SCRAPE_EGRESS_IN_PAYLOAD`, **terminal**, thrown BEFORE `driver.open()`. Shorter than `MIN_REDACTABLE_LENGTH` is not checked (`scrape-service.test.ts`) |
| a rented browser is released EXACTLY once | `cdp-resolver.ts`'s `acquireCdp()` latches `release`. `remoteBrowser.open()` releases on every throw after the rental exists (`runScrape`'s `finally` cannot close a session `open()` never returned); `close()` quits the browser FIRST, then releases; neither can throw (`cdp-resolver.test.ts`) |
| a stored session is SEALED, and nothing else in the bucket is read | `storageSessionStore` writes `{ sealed }` through core's `seal()` (purpose `SESSION_SEAL_PURPOSE`) — never WebCrypto here (`scripts/seal-calls.ts`). `load()` resolves the key ring FIRST and outside every catch: no key is `X_SEAL_KEY_MISSING` before the browser opens, never "no session". An unsealed, unopenable or other-key record is BURNED — no migration, no legacy read; the record's own `key` is compared because the purpose is one constant (`session-seal.test.ts`) |
| a prompt wait keeps the session, and never suspends the run | `event-prompt.ts` polls `EventBus.find` in process; `step.waitForEvent` would end the attempt and close the browser. Between polls it calls `PromptRequest.keepAlive()` — one `page.count()` — so the wedge watchdog and a rented browser see activity. Only an answer published AFTER the ask is consumed (the run id is the same on every attempt); "after" is read on the bus's own clock (`bus.now()`), never the worker's. The answer is sealed with the EVENT NAME as purpose (`event-prompt.test.ts`, `session.job.test.ts`) |
| how a run ended reaches the app through the JOB's `onSettled`, never a second hook | `scrape()` wraps it: `completed` carries the `ScrapeReport` (the job's own `result`); a failed ending carries the last attempt's `usage`, kept by run id in `usage.ts` (`rememberFailedUsage` / `takeFailedUsage`, bounded at 256, taken on EVERY ending). Recorded only when the definition declares `onSettled` (`scrape-service.test.ts`) |
| a disk is a THUNK | `storageSessionStore(() => disk(…))` and `artifacts.storage` are read per call: a scrape is declared at module evaluation, the app's disks exist after `defineStorage()`. A driver value is a compile error |
| the clock is the PROCESS's unless the definition pins one | `definition.clock ?? scrapeClock()`; `setScrapeClock()` / `resetScrapeClock()` are the test seam, `noWaitClock` the clock for a run that waits on the test itself (`testClock()` runs a budget out in microtasks) |
| usage is counted where activity is reported | `SessionInit.usage` → `PageContext.usage` (`goto`), `HttpTransportInit.usage` / `RecordedHttpInit.usage` (one per hop, body bytes). `bytesIn` is the HTTP leg ONLY — the CDP port has no sizes. `browserCost` is parsed with `t.money` in `acquireCdp()` (`usage.test.ts`) |
| a remote robots pattern cannot stall the worker | `robots.ts`'s `patternMatches` WALKS the pattern (`*` and `$`, no compilation), so a wildcard-dense rule from a scraped site is linear instead of catastrophic backtracking on the worker's only thread (`robots.test.ts` pins the walk against the compiled oracle it replaced, plus a deadline assertion) |
| robots is enforced on BOTH legs | `http-recorded.ts` takes the gate too (`http-recorded.test.ts`) — the offline leg is the one every test runs, so a `Disallow:`ed endpoint that only the live leg refuses is a rule no suite can see |
| a session cookie reaches one host | `cookie-scope.ts`, RFC 6265 §5.1.3/§5.1.4, pinned in `cookie-scope.test.ts`. The jar is `browser.cookies()` — every domain the session touched — so the boundary is a dot in both directions: `evilbank.test` is not `bank.test`, and a host-only cookie is not a subdomain's |
| a launched browser is never orphaned | `driver-cdp.ts`'s `opened()` rolls back with `browser.close()` on any throw between the launch and the `WedgeGuard` (`driver-cdp.test.ts`) — `runScrape`'s `finally` cannot close a session `open()` never returned |
| restored `localStorage` lands on its ORIGIN | `cdp-target.ts` defers the storage half to the first navigation that reaches `session.origin` (`cdp-target.test.ts`); `restore()` runs on `about:blank`, which has no storage to write to and is not the site |
| a capture's framing is decided ONCE, before any driver | `page-over-target.ts` calls `assertCaptureFraming`, the single constructor of a capture request: `clip` + `fullPage`, a zero-area rectangle or a clip on a PDF is `X_SCRAPE_CAPTURE_INVALID`, **terminal**. The viewport is deliberately not checked (`capture-clip.ts`). Offline drivers answer different deterministic bytes per rectangle, so a driver that drops the clip fails |
| a theme picture is taken by emulating the PREFERENCE, never by setting an attribute | `page.colorScheme(scheme)` → `ScrapeTarget.setColorScheme` → CDP `Emulation.setEmulatedMedia` (`color-scheme.ts`, `cdp-target.ts`); a component resolving `'system'` overwrites `data-theme` on mount (#338: byte-identical light/dark shots). REQUIRED on `ScrapeTarget`; a launcher without `emulateMediaFeatures` is `X_NOT_IMPLEMENTED`. ACCEPTED offline (`html-target.ts` answers different bytes per scheme), unlike `setOfflineMode`. `'no-preference'` sends CDP's EMPTY feature list — a reset, not an override |
| which HTTP statuses the second leg may repeat is CORE's | `error-throws.ts`'s `httpFailed` reads `isRetryableStatus` from `@ultimat3/core` (`>= 500` plus 408, 409, 425, 429) — never a local table. A sub-400 non-ok (a 304) keeps the code's registered `retryable` (`errors.test.ts`) |
| a frame verb reaches the FRAME | both targets build a frame target by SPREADING the parent's, so every verb not overridden acts on the parent document. `driver-parity-frames.test.ts` drives `fill`, `type`, `select`, `click` and `query` through a frame on all three drivers, against a parent and a frame carrying the SAME ids |
| the browser's own keys are read, never refused by name | `browser-record.ts` is the one reader for a string map that came out of a browser — element `attrs`, `localStorage`. `t.record()` refuses `__proto__`/`constructor`/`prototype`, right for a request body and wrong for a DOM: `<div constructor="Foo">` refused a whole `query()`, and `guard()` then re-labelled it `X_SCRAPE_BROWSER_UNREACHABLE`, registered RETRYABLE. Null-prototype for `headerRecord`'s reason |
| a permanent refusal is never re-labelled retryable | `cdp-target.ts`'s `guard()` passes `X_NOT_IMPLEMENTED` and `X_VALIDATION_FAILED` through and wraps everything else as `X_SCRAPE_BROWSER_UNREACHABLE` — never `instanceof UltimateError`, which would unwrap a timeout raised on a dead socket (`cdp-target-surface.test.ts`). Open half: neither passed-through code is classified `terminal` by its owner (`@ultimat3/core`, `@ultimat3/schema`), so the job's attempt count governs |
| an uncaught page exception is OBSERVED, and is not a crash | `cdp-target.ts` subscribes to `pageerror` (`PageEvent.PageError`), which must never reach the `crashed` latch (`X_SCRAPE_PAGE_CRASHED`, terminal). `ScrapeTarget.pageErrors` is a REQUIRED ring — the offline target never pushes to it (`driver-parity.test.ts`) — and entries go through `pageErrorEntry()` (`rings.ts`), keeping the stack, truncated at `MAX_PAGE_ERROR_CHARS` |
| a `Promise`-typed method REJECTS, never throws | `cdp-target.ts`'s `download()` returns `Promise.reject(…)`, `html-target.ts`'s is `async`, and `page-over-target.ts` forwards through an `async` method so a third-party `ScrapeTarget` that throws synchronously still reaches the caller's `.catch()`. A synchronous throw from a promise-typed method jumps over `page.download().catch(…)` entirely |
| `page.url()` is the TARGET's, never a cached seed | `page-over-target.ts` spreads `...frame` and must override `url`: a frame answers from `lastUrl`, the page holds its target. Without it every `page.url()` was `about:blank`, and `packages/cli/src/shot-verdict.ts` gates `ok` on it. `driver-parity.test.ts` asserts it on all three drivers |
| a fired watchdog still QUITS | `watchdog.ts` keeps `stopped` (the loop) and `shuttingDown` (the teardown) as two latches, so `shutdown()` after a fire still calls `quit()` — `remoteBrowser()` has no pid to kill (`watchdog.test.ts`) |
| the watch loop is never floating | `void watch().catch(…)` ends the run with `X_SCRAPE_WATCHDOG_STOPPED` (its own code, **terminal**: the clock is the definition's), never an unhandled rejection. The ceiling's own `clock.sleep` is caught too — `close()` runs in `runScrape`'s `finally` and may never throw |
| Chrome is never needed for `bun test` | `fakeBrowser`/`fakePage` run on Bun's own `HTMLRewriter` |

## Every numeric bound here is screened, and `??` is not the screen — `As of 2026-08-26`

`NaN` is not nullish, so a `??` default never fires for it, and `Math.min`, `Math.max` and
`Math.floor` PROPAGATE it rather than validating. `finiteOption`/`finiteCount` from `@ultimat3/core`
are the one form — never a local copy, which is what `scripts/flight-copies.ts` exists for — and
`bun run finite-bounds` is the ratchet. It saw 9 of these sites; the four it CANNOT see (a required
option with no `??`, and a value that arrives through `toMillis`) were the worse half.

| Bound | What a non-finite one DID |
|---|---|
| `pageTimeout` → `deadline()` | `Math.max(0, NaN - elapsed)` is `NaN` and `NaN <= 0` is false, so `expired()` never answers true and BOTH `for (;;)` loops — `awaitActionable` and `page-over-target.ts`'s `frame()` — run forever. Measured against `systemScrapeClock`: **835,462 polls in 3s, 278,487/s**, one CDP round trip each, past `ctx.signal` and past the job timeout |
| `pollMs` | `Math.min(NaN, remaining)` is `NaN`, and `setTimeout(fn, NaN)` is `setTimeout(fn, 0)` — the same spin inside a budget that does expire. `0` is refused for that reason and not for tidiness |
| `robots` `timeoutMs` / `maxBytes` | a `NaN` deadline THROWS out of `AbortSignal.timeout` into the gate's `.catch`. Until 2026-10 a failed read meant "no restrictions" and robots went off for the run in silence; it is now unreachable (RFC 9309 §2.3.1.4), so a bad bound refuses every origin — screened at construction either way. `scrape-run.ts` feeds this the run's `pageTimeout`, so it arrived from a declaration |
| `http.request` `timeout` / `maxBytes` | the same `AbortSignal.timeout` throw, as a bare `TypeError` reaching the job's retry classifier unclassified — the one thing `scrapeTimeout` exists to prevent. Both are screened BEFORE the request leaves: `readWithinLimit`'s own refusal arrives once a POST has already been performed |
| `watchdog.idleMs` | `elapsed < NaN` is false, so the guard fires on the FIRST 250ms poll and every run dies as `X_SCRAPE_WEDGED` against a browser that answered. `Infinity` is the mirror: the loop never fires, which is incident #1 with nothing armed |
| `watchdog.graceMs` | `clock.sleep(NaN)` is 0, so `browser.close()` cannot win the race and `kill()` runs instead — and on `remoteBrowser()`, where `process()` is `null`, that reaches nothing and the paid remote session outlives the run |
| `auth.maxAge` | `age > NaN` is false, and false there means RESTORED: a session of any age handed back, no re-login, nothing in the report |
| `expect.minRows` / `maxDrop` / `window` | the alarm's own numbers. `rows < NaN` is false, so the floor never fires and a zero-row scrape stays green forever — the exact failure this package's `expect` exists to prevent. `window` is worse than it looks: `slice(-0)` is `slice(0)`, the WHOLE history |
| `rate` | already refused by `scrape()` where it is written, and screened again in `runScrape` — `runScrape` is exported, so a definition assembled by hand never passes that assert. The layered form, not a second rule |

**The floors are claims, and each one is asserted.** `0` is legal where a caller means something by
it and refused where it is the same outcome as `NaN`: `page.waitFor({ timeout: 0 })` is one look and
no wait, `watchdog.graceMs: 0` declines the polite close, `auth.maxAge: 0` restores nothing,
`expect.minRows: 0` is the declaration this package asks a legitimately-zero scrape to write. A
SESSION default of `0` (`pageTimeout`, `fakePage({ timeoutMs })`) is refused, because it is every
wait and every navigation already out of time. `<file>-bounds.test.ts` beside each source holds both
sides, and flipping a floor turns exactly one of them red.

**Two comparisons fail closed instead** (this one and `http-recorded.ts`'s `recordedAt`), because a screen cannot reach them: `restorableSession`'s
`age` comes from `found.savedAt`, which is a string in a bucket that `parseSessionState` only checks
is a string. `!(age <= limit)` and never `age > limit` — the same test for every finite age, the
opposite one for a `NaN`.

## Logging

Structured lines go through `ctx.logger` (core's `Logger`) — this package ships **call sites and a
field vocabulary, never a sink**. `ScrapeEventFields` is a CLOSED type, which is the mechanism that
keeps a session cookie out of a log line: there is no key to put one in. Secrets are additionally
boxed by core's `Secret`, and sessions are summarised by `sessionDigest()` — counts and an origin,
never a value.

## Secrets and sessions

- `secrets:` on the definition holds **names**; values are resolved in the worker, per attempt.
- A `Secret` typed into a page **taints** it: `screenshot()` and `pdf()` then refuse
  (`X_SCRAPE_SECRET_EXPOSED`). Pixels cannot be redacted after the fact; `page.html()` can, and is.
- A session is credential material: tenant-scoped key, never logged, never an artifact. The key is
  ALWAYS `sessionKeyFor({ scrape, tenant, discriminator })` — `auth.key` supplies the
  discriminator and never the whole key, or two tenants naming one account share one authenticated
  session, and a key that is also a storage path goes unsanitised (`scrape-run.test.ts`).
- **Each part of that key is ENCODED, never collapsed** — every segment is
  `<sanitised>.<16 hex of sha256(raw)>`: readable in a listing, injective for identity
  (`alice@corp.com` and `alice-corp.com` are two keys). `assertSafeKey` still refuses `..`.
- **`profileDir` in the `rm -f` fix goes through `renderFixShellArg`** (`As of 2026-09-06`).
  `X_SCRAPE_PROFILE_LOCKED` is the one line in this package that tells a reader to paste an `rm`,
  and the directory is the app's — `localBrowser({ profileDir })`, composed from a tenant id on a
  multi-tenant run — so a `$(…)` in it runs before `rm` does. A path a shell would read becomes
  `<the profile directory the cause names>`; the directory itself stays in the `cause`.
- **Values learned MID-RUN are redacted too**: `ScrapeSecrets.conceal(value)` adds to the same
  set `redactSecrets` reads (a module-private `WeakMap` — no way to read one back). Callers: a
  prompt answer (`createPrompt`), an `egress` URL's password (`runScrape`, and `exitFor()` for a
  driver's own `proxy`), every credential-bearing part of a CDP URL (`remoteBrowser`).
  `url-secrets.ts` is the one split of a URL into what may be printed (`endpointLabel`: scheme and
  host) and what may not (`urlSecretValues`: credential-shaped query values and path segments only). `X_SCRAPE_CDP_ATTACH_FAILED` prints the label for a
  fixed URL as for a resolved one, and cuts those values out of the launcher's own message
  (`cdp-redaction.test.ts`).
- **Redaction is by VALUE, in every encoded spelling (`spellingsOf`), and covers four surfaces, each with a caller**: `safeHtml`,
  `safeConsole`, `safeNetwork`, `safePageErrors`, plus `X_SCRAPE_HTTP_FAILED`'s cause (redacted at
  its throw site; `HttpTransportInit.secrets` / `RecordedHttpInit.secrets` carry the bag). Not
  redacted, deliberately: other errors' `cause`/`meta` URLs, values shorter than
  `MIN_REDACTABLE_LENGTH`, and pixels — which is why a typed secret TAINTS the page.
- Burn and tombstone compare a `version` first: another run's newer record is kept; a failed post-login save is logged, not fatal (`session-race.test.ts`).
- The refusal tombstone is read BEFORE `reuse` is honoured: `reuse: false` means "do not restore
  this session", never "present the rejected credential again" (`auth.ts`).
- `X_SCRAPE_AUTH_FAILED` is registered `terminal`, so `executeJob` dead-letters it on the attempt
  that threw it (`packages/jobs/src/retry-classification.ts` — `nextRetryForError`). It ALSO writes
  a refusal into the session record, which is a different distance: `restorableSession()` reads it
  before `driver.open()`, so a replay or a manual requeue refuses without spending a browser, a CDP
  attach or a request. The classification makes it terminal; the tombstone makes it cheap.
- The classification is load-bearing, not documentation: `classifyThrown` honours a `terminal` only
  for a code that is REGISTERED, so every owned code goes through `registerErrorRetry` in
  `errors.ts` — `errors.test.ts` fails if one is added without a classification.

Why each rule above is shaped the way it is: [`docs/history/scraping.md`](../../docs/history/scraping.md).
