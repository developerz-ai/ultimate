# 06 — Tier 5: scraping, testing

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5.

## Files to change
- `packages/scraping/src/page-over-target.ts:81,91,104,194` — `frameOver` seeds `lastUrl` at construction and refreshes it only in `wait()`; `pageOverTarget` spreads `...frame` and overrides `goto`/`screenshot`/… but not `url`. `ScrapeTarget.url()` is live on all three drivers (`html-target.ts:174`, `cdp-target.ts:292`). **Proven**: `url()` answers `about:blank` before and after `goto` and after `text()`. Consumers: `packages/cli/src/cmd-shot.ts:177` (`finalUrl`) — so **`x shot` exits non-zero on every route**, summary "redirected to about:blank" — and `packages/scraping/src/auth.ts:87` (`PromptHandler` gets `about:blank`).
- `packages/scraping/src/watchdog.ts:63,81,86-97` — `watch()` sets `stopped = true` when it fires; `shutdown()`'s first line is `if (stopped) return`, so a fired guard never calls `quit()`. On `localBrowser()` `kill()` reaches a pid; on `remoteBrowser()` — "the PRIMARY production path" (`driver-cdp.ts:6`) — `browser.process()` is `null` (`driver-cdp.ts:76`), so nothing ends the remote session. **Proven**: after `fired`, `shutdown()` → `{ quits: 0, kills: 1 }`. `watchdog.test.ts` has no shutdown-after-fire case.
- `packages/scraping/src/watchdog.ts:70` — `void watch()` floating; an injected `ScrapeClock.sleep` that rejects is an unhandled rejection. Attach the handler `scrape-run.ts:198` uses.
- `packages/testing/src/fixture-island.ts:80,170` — `MODULE_DIR` `mkdtempSync`'d at module scope, never removed; one directory per test process.

## Steps
1. `pageOverTarget`: add `url: () => target.url()` to the returned object beside the other overrides at `:194`. (Verified during the audit: with this one line `x shot` answers `finalUrl: …/dash`, `redirected: false`, `ok: true`.)
2. `watchdog.shutdown()`: gate on a `shuttingDown` latch rather than `stopped`, so the existing `quit`/`kill` race at `:86-97` runs after a fire too.
3. `void watch().catch(...)` → record the rejection the way `recordSessionOutcome` does.
4. `fixture-island.ts`: remove the directory on `process.on('exit')` beside the `mkdtempSync`, or through the `Disposable` the fixture already returns.

## Tests
- `packages/scraping/src/driver-parity.test.ts` — `page.url()` equals the navigated URL after `goto` on fake, fixture and CDP; currently **no test calls `page.url()`**.
- `packages/scraping/src/watchdog.test.ts` — `idleMs: 1_000`, spin the test clock until `fired`, `await shutdown()` → `quit` called once, then `kill`.
- `packages/scraping/src/watchdog.test.ts` — injected clock whose `sleep` rejects → the guard reports, the process does not die.
- `packages/testing/src/fixture-island.test.ts` — after dispose, the module dir is gone.
- Command: `bun test packages/scraping/src/driver-parity.test.ts packages/scraping/src/watchdog.test.ts packages/testing/src/fixture-island.test.ts`.

## Done when
- Tests fail-then-pass; `x shot /` in `examples/dummy` with a local Chrome answers `ok: true` on a clean page (manual, needs a browser; not a gate step by design — `packages/cli/CLAUDE.md`).
