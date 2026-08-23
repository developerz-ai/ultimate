# @ultimat3/scraping — boundary

Tier 5. May import tiers 0-4. Never sideways, never upward.

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *` — and complete enough that a third party implements `ScrapeDriver` from it alone. A driver author needing a deep import means the seam is not a seam |
| Errors | `src/errors.ts` owns the codes and their **retry classification**; `src/error-throws.ts` owns one constructor per failure mode |
| Files | one responsibility each, tests beside the source |
| Dependencies | `@ultimat3/core`, `@ultimat3/jobs`, `@ultimat3/schema`, `@ultimat3/storage`. **No third-party runtime dependency at all** |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Public docs: [`wiki/Scraping.md`](../../wiki/Scraping.md) — the only public surface. A capability this file
claims and that page does not carry is a capability an app author cannot find.

## Tier 5, and why not lower

`jobs` is tier 3 and `storage` is tier 1, so today's imports would allow tier 4. It sits at 5
because `recover: 'agent'` is designed to import `@ultimat3/ai` (tier 4), and a package at 4 cannot
import a package at 4. Moving up later would be a table change with consumers already attached.

The cost is real and worth stating: `cli` is also tier 5, so a CLI command that drives a browser
needs a declared `cli -> scraping` edge in `scripts/lib/tiers.ts`. **Declared 2026-08-21**, when
`x shot` became its first importer.

Moving this package down to 4 was considered at that point and refused, which is the decision this
section exists to survive: tier 4 is what today's imports allow, so the move would have deleted the
exception line — but it would also have foreclosed `recover: 'agent'`, and a table with one fewer
line is not worth a capability. The reasoning that retired `admin -> ui` does not transfer: `ui` was
at 5 by accident, this package is at 5 on purpose.

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
| an unrecorded request throws | `html-target.ts` and `http-recorded.ts` — an offline driver that fell through to the network would make a green suite secretly live. **One request escapes this and it is the robots read**: `fakeBrowser`/`fixtureBrowser` under the default `robots: 'obey'` fires a real `fetch` at `https://<host>/robots.txt` before the first navigation, because the gate is built in `scrape-run.ts` and knows nothing about which driver `open()` will be. Measured 2026-08-19: one egress per origin per run, and under `bun test` the sealed network's refusal is swallowed by `robotsFetcher`'s `catch { return undefined }` — which the gate reads as "no restrictions". Green either way, which is the whole problem. Declare `robots: { ignore: '<reason>' }` on an offline scrape → `wiki/Known-Gaps.md` |
| `allowHosts` is enforced, never advisory | `intercept.ts` is the single decision, asked by every driver AND by the HTTP leg, before a byte leaves |
| the robots read is deadlined and capped | `robots-fetch.ts` is the ONE default `/robots.txt` read, with `DEFAULT_ROBOTS_TIMEOUT_MS`, `DEFAULT_ROBOTS_MAX_BYTES` and the session's proxy when there is one (`robots-fetch.test.ts`). The proxy is a RESOLVER, not a string, and `ScrapeSession.proxy` is where it comes from: the gate is an argument to `driver.open()` while the exit is a driver option resolved inside it, so a value passed at construction could only ever be the one nobody has yet — the read left from the worker's IP while every page load left through the proxy, and an origin reachable ONLY through the proxy read as "no robots.txt", which is allow-everything (`scrape-run.test.ts`, `driver-cdp.test.ts`). `timeoutMs`, `signal` and `proxy` are each independently optional; the deadline and the cap are not. `scrape-run.ts` supplies the run's page timeout and `ctx.signal` — the gate caches one promise per origin, so a read with no deadline parks every later navigation to that origin where `ctx.signal` cannot reach it |
| the exit is a DRIVER option, and `SessionInit.proxy` is a lie | `driver.ts:30` declares `proxy?: string` with the comment "BOTH transports dial through it" and **nothing dials through it**: `scrape-run.ts:103` builds the whole `SessionInit` without the key, `driver-cdp.ts` reads its own `options.proxy` (explicitly, `// options.proxy and not init.proxy`), and the fake and fixture drivers read neither. Setting it changes no exit IP. It is the same shape as the robots read the proxy resolver just closed, one field over — the seam declares a capability the only caller never passes. Pass `localBrowser({ proxy })` / `remoteBrowser({ proxy })` and read `ScrapeSession.proxy` back → `wiki/Known-Gaps.md` |
| a remote robots pattern cannot stall the worker | `robots.ts`'s `patternMatches` WALKS the pattern (`*` and `$`, no compilation), so a wildcard-dense rule from a scraped site is linear instead of catastrophic backtracking on the worker's only thread (`robots.test.ts` pins the walk against the compiled oracle it replaced, plus a deadline assertion) |
| robots is enforced on BOTH legs | `http-recorded.ts` takes the gate too (`http-recorded.test.ts`) — the offline leg is the one every test runs, so a `Disallow:`ed endpoint that only the live leg refuses is a rule no suite can see |
| a session cookie reaches one host | `cookie-scope.ts`, RFC 6265 §5.1.3/§5.1.4, pinned in `cookie-scope.test.ts`. The jar is `browser.cookies()` — every domain the session touched — so the boundary is a dot in both directions: `evilbank.test` is not `bank.test`, and a host-only cookie is not a subdomain's |
| a launched browser is never orphaned | `driver-cdp.ts`'s `opened()` rolls back with `browser.close()` on any throw between the launch and the `WedgeGuard` (`driver-cdp.test.ts`) — `runScrape`'s `finally` cannot close a session `open()` never returned |
| restored `localStorage` lands on its ORIGIN | `cdp-target.ts` defers the storage half to the first navigation that reaches `session.origin` (`cdp-target.test.ts`); `restore()` runs on `about:blank`, which has no storage to write to and is not the site |
| a capture's framing is decided ONCE, before any driver | `page-over-target.ts` calls `assertCaptureFraming` — the single constructor of a capture request — so `cdp-target.ts` and `html-target.ts` cannot disagree about `clip` + `fullPage`, a zero-area rectangle or a clip on a PDF. Every one of those is `X_SCRAPE_CAPTURE_INVALID`, **terminal**: the rectangle is the caller's own literal and attempt 2 passes the identical one. What is deliberately NOT checked is the viewport — nothing in `src/` sets or reads one, so the answer would cost a round trip and would refuse the below-the-fold component the crop exists for (`capture-clip.ts`). The offline drivers answer different deterministic bytes per rectangle, because CI has no Chrome and a fake that ignored the clip would let a driver that drops it pass every test |
| which HTTP statuses the second leg may repeat is CORE's, never this package's | `error-throws.ts`'s `httpFailed` reads `isRetryableStatus` from `@ultimat3/core` — the framework's one table (`>= 500` plus 408, 409, 425, 429). This package shipped the FIFTH copy of it (`status !== 429`) and the copy had drifted: a 408, a 409 and a 425 were `terminal` here while `cache`, `mail` and `ai` called the same status retryable, and terminal is not a label — `nextRetryForError` dead-letters the run on the attempt that threw, so a scrape spent a five-attempt policy on one request timeout. The 4xx WINDOW stays local because it is the range the override speaks for: a sub-400 non-ok (a 304) keeps the code's registered `retryable` rather than earning an early dead letter from a table that never classified it (`errors.test.ts`) |
| a permanent refusal is never re-labelled retryable | `cdp-target.ts`'s `guard()` passes `X_NOT_IMPLEMENTED` through — the one code that means "this build does not have the feature", which a browser cannot produce — and wraps everything else as `X_SCRAPE_BROWSER_UNREACHABLE`. `instanceof UltimateError` is the naive version and is wrong: it would unwrap an `X_SCRAPE_TIMEOUT` raised while the socket was already dead, and that wrap is what makes a disconnect legible (`cdp-target-surface.test.ts` pins both sides). The half this package cannot close: `X_NOT_IMPLEMENTED` is core's code and nobody classifies it, so `classifyThrown` reads it as unclassified and the job's attempt count still governs — `registerErrorRetry({ X_NOT_IMPLEMENTED: 'terminal' })` belongs in `@ultimat3/core`, beside the code it names, not in a second package's table |
| an uncaught page exception is OBSERVED, and is not a crash | `cdp-target.ts` subscribes to `pageerror` beside `console` and `request` — puppeteer's `PageEvent.PageError` ("an uncaught exception happens within the page"), which is NOT `PageEvent.Error` ("the page crashes") one line below it and must never reach `crashed`: that latch answers `X_SCRAPE_PAGE_CRASHED`, registered `terminal`, for a page that still renders. Until 2026-08-21 nothing in the package subscribed to it at all, so an island that threw was invisible to `page.console()` and to `x shot`'s verdict alike. `ScrapeTarget.pageErrors` is a REQUIRED ring — the offline target builds one and never pushes to it (`driver-parity.test.ts` pins the divergence: no JS engine offline), because an optional one would let a driver be silent about errors it can see. Entries go through `pageErrorEntry()` (`rings.ts`), which is what keeps a stack — the field that names the island — and truncates it at `MAX_PAGE_ERROR_CHARS` |
| a `Promise`-typed method REJECTS, never throws | `cdp-target.ts`'s `download()` returns `Promise.reject(…)`, `html-target.ts`'s is `async`, and `page-over-target.ts` forwards through an `async` method so a third-party `ScrapeTarget` that throws synchronously still reaches the caller's `.catch()`. A synchronous throw from a promise-typed method jumps over `page.download().catch(…)` entirely |
| `page.url()` is the TARGET's, never a cached seed | `page-over-target.ts` spreads `...frame` and must override `url` with it. `ScrapeFrame` resolves its target asynchronously while `url()` is synchronous, so a frame can only answer from a `lastUrl` refreshed on its last wait — the PAGE holds its target and has no such excuse. Without the override every `page.url()` answered the construction seed, `about:blank`, before and after `goto`: `x shot` reads it as `finalUrl`, and `packages/cli/src/shot-verdict.ts:191` gates `ok` on `requestedUrl === finalUrl`, so **every route of every app** reported `ok: false` and "redirected to about:blank". `auth.ts:87` handed the same string to a `PromptHandler`. `driver-parity.test.ts` asserts it on all three drivers; nothing had ever called `page.url()` |
| a fired watchdog still QUITS | `watchdog.ts` keeps `stopped` (the watch loop) and `shuttingDown` (the teardown) as two latches. They were one, so `shutdown()` returned on its first line after a fire and never called `quit()`. `localBrowser()` hid it — the fire's `kill()` reaches a pid — while `remoteBrowser()`, the primary path, has `browser.process() === null`, so the paid remote session ran until its provider timed it out. `watchdog.test.ts` covers shutdown-after-fire, both quit outcomes |
| the watch loop is never floating | `void watch().catch(…)` ends the run with `X_SCRAPE_WATCHDOG_STOPPED` through `watchdogStopped()`, rather than becoming an unhandled rejection with the guard silently dead behind it. `ScrapeClock` is a seam an app implements and `kill()` is a driver's, so the loop runs third-party code. Its OWN code and not `X_SCRAPE_WEDGED`: an exact `cause:` cannot rescue a wrong title, and `x errors explain X_SCRAPE_WEDGED` sends the reader to a page that is fine. **Terminal** where the wedge is retryable — the clock is the definition's and attempt 2 reaches the same one, so retrying is five browser launches and five arrivals at a login for no chance of a different answer. The ceiling's own `clock.sleep` is caught too: `close()` runs in `runScrape`'s `finally` and may never throw |
| Chrome is never needed for `bun test` | `fakeBrowser`/`fakePage` run on Bun's own `HTMLRewriter` |

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
