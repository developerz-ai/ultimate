# 25 — The scrape watchdog ends the run on an attached browser

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`scraping`).

## Why
A fire on `remoteBrowser()` closes nothing. Probe, `createWedgeGuard` past its idle budget: `{ fired: true, aborted: true, quits: 0, kills: 1 }`. The kill is `browser.process?.()`, null when attached (`packages/scraping/src/driver-cdp.ts:154-159`). `quit()` runs only from `close()` (`driver-cdp.ts:208`), which waits for the run to unwind, and a call blocked on the socket does not unwind: `evaluate` takes no signal (`packages/scraping/src/cdp-target.ts:173`).
One adopter's production run kept driving the site for minutes after its guard fired, ending `X_SCRAPE_WEDGED` only at the next sleeping wait.
The clock also misses real work. Probe, activity per verb: `evaluate` +1, `cookies` +0, `session` +0, `screenshot` +0, `pdf` +0 (`packages/scraping/src/page-over-target.ts:271-272,293-294`). An app's own CDP channel cannot report at all, since `SessionInit.onActivity` is outbound only. That adopter routes its extras through `page.evaluate` just to stay alive, and read a minutes-long warm-up as a dead browser before that.
One adopter, but the only heavy one: 564 files import this package.

## Files to change
- `packages/scraping/src/watchdog.ts` — the fire also runs the graceful quit under `graceMs`; `shutdown()` shares that promise.
- `packages/scraping/src/page-over-target.ts:271-272,276,293-294` — each verb reports activity.
- `packages/scraping/src/page.ts:122` — `ScrapePage.activity(): void`.
- `packages/scraping/src/offline-session.ts:56` — same on offline drivers, so a run body never branches on the driver.
- `wiki/Scraping.md`, `packages/scraping/README.md`, `packages/scraping/CLAUDE.md`.

## Steps
1. On a fire: set `fired`, `kill()`, start `quit()` unawaited with its failure caught, then abort with `wedged(...)`. Order stays kill before abort; the closing socket is what rejects a pending call.
2. Past `graceMs` with `quit()` unsettled, `kill()` again. `shutdown()` after a fire awaits the same teardown and never runs `quit()` twice.
3. A rejection from a closed socket after a fire surfaces as `X_SCRAPE_WEDGED`, not `X_SCRAPE_BROWSER_UNREACHABLE`: `guard()` at `cdp-target.ts:139` wraps it, so `runScrape` must prefer the fired guard's reason. Without this the run's error code changes.
4. `page.activity()`: the app's statement that its own channel is working. Touches the guard only; counts no usage.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_SCRAPE_WEDGED` (existing) | the guard fired, on any driver | raise `watchdog.idleMs`, or call `page.activity()` from a channel the framework cannot see |

## Tests
- `packages/scraping/src/watchdog.test.ts`: a fire with `kill` a no-op calls `quit` once; a later `shutdown()` adds none; a hung `quit` gets a second `kill` at `graceMs`.
- `packages/scraping/src/driver-cdp.test.ts`: a `remoteBrowser` whose `evaluate` never settles until `close()` rejects with `X_SCRAPE_WEDGED` at the idle budget. Fails today: it hangs.
- `packages/scraping/src/page-over-target.test.ts`: every verb, and `activity()`, adds one touch.
- `bun test packages/scraping/src/watchdog.test.ts`

## Semver
**Breaking, one row.** The exported `ScrapePage` gains a required member. An attached browser now closes at the fire rather than at unwind.
Upgrading: "A hand-written `ScrapePage` fake adds `activity(): void`. The shipped fakes carry it."

## Done when
- The probe prints `quits: 1`.
- A hung `evaluate` on an attached browser settles within `idleMs + graceMs`, with `X_SCRAPE_WEDGED`.
- `wiki/Scraping.md` names `page.activity()`.
- `bun test packages/scraping` and `bun run verify` green.
