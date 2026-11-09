# @ultimat3/scraping — what a non-finite bound did

Moved out of [`packages/scraping/CLAUDE.md`](../../packages/scraping/CLAUDE.md) (plan 101 slice 21,
`As of 2026-11-09`) to keep that file under its size ceiling; the rule stays there. A record of
why, never a current fact. `systemScrapeClock` below is core's `systemClock` since 31.0.0.

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
