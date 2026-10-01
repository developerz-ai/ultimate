# 09 — Scraping: a session a service can be built on

> Part of [`overview.md`](overview.md). Depends on: 01, 04. Tier: 5.

Rule: `scrape()` stays one `job` factory (`packages/scraping/src/scrape.ts:129-158`). Each gap
below is a field on its definition or on its driver, never a second factory.

Target shape, from the surveyed service contract: caller opens a session → events stream out →
input goes in mid-run → one terminal result. One session per connection. Secrets in memory only.
Egress chosen per session. Usage on every result. The browser is whatever answers at a CDP URL.

## Files to change
| File | Change | Why |
|---|---|---|
| `packages/scraping/src/scrape.ts:60-110` | `egress?: (input: I) => string \| undefined` | `SessionInit.proxy` (`packages/scraping/src/driver.ts:30`) is declared and read by nothing; the CDP driver uses `options.proxy` only (`driver-cdp.ts:119-122,145,175`) |
| `packages/scraping/src/scrape-run.ts:121` | pass `egress(input)` as `init.proxy` | the session's exit is the run's decision, not the driver's constant |
| `packages/scraping/src/driver-cdp.ts:46-49` | `cdpUrl: string \| CdpResolver` | a rented browser is acquired per session and must be released |
| `packages/scraping/src/scrape.ts:112-127` | `ScrapeReport.usage` | cost per run is asked for by every surveyed system |
| `packages/scraping/src/session-state.ts:170-178` | seal stored sessions with `seal()` | the file's own note: "NOT encrypted at rest" |
| `packages/scraping/src/auth.ts:28-39` | a shipped `PromptHandler` over the job event bus | a human or an OTP source answers while the browser stays open |
| `packages/scraping/src/scrape.ts:103` | `concurrency` accepts slice 04's keyed form | one session per connection |
| `packages/scraping/src/errors.ts` | `X_SCRAPE_EGRESS_UNSUPPORTED` | a driver that cannot honour a per-session exit says so |

Plus `packages/scraping/README.md`, `packages/scraping/CLAUDE.md`, `wiki/Scraping.md`,
`wiki/Known-Gaps.md:36` (the proxy row).

## Steps
1. **Egress.** `init.proxy` wins over `options.proxy` in `localBrowser` and in the HTTP leg; the
   session still reports the exit it dialled (`driver.ts:42-53`), so the robots read keeps leaving
   through the same exit. A remote driver whose URL is already bound to an exit and is handed a
   different one throws `X_SCRAPE_EGRESS_UNSUPPORTED`.
2. **Resolver.** `CdpResolver = (request: { scrape, runId, egress, signal }) =>
   Promise<{ cdpUrl: string; release?: () => Promise<void>; costMinor?: Money }>`. `release` runs
   in the session's `close()`, once, on success, failure and abort. A vendor wrapper is ~20 lines
   of app code; the framework ships no vendor.
3. **Usage.** `{ browserMs, navigations, httpRequests, bytesIn, promptsAnswered, browserCost? }`.
   `browserCost` is the resolver's `Money`, never a float. Counted where `onActivity`
   (`driver.ts:36`) already fires. No quota, no plan, no ledger: see `overview.md` *Risks*.
4. **Sealed sessions.** `storageSessionStore` seals on save and opens on load, purpose
   `scrape-session`. An unsealed blob found on load is burned and the run re-authenticates: a
   session is a cache, so there is no migration.
5. **Prompt.** `eventPrompt({ event: (request) => string, timeout })` returns a `PromptHandler`
   that polls the job event bus (`packages/jobs/src/events.ts`) in process. It must NOT use
   `step.waitForEvent`: that suspends the run (`packages/jobs/src/steps.ts:6`) and closes the
   browser the site is waiting in. Heartbeats continue; the run's `signal` aborts the wait; a
   timeout is `X_SCRAPE_PROMPT_UNANSWERED`, classified terminal.
6. **Redaction.** A prompt answer and an egress URL with credentials are added to the run's
   secret set (`packages/scraping/CLAUDE.md:122-141`) so neither reaches an artifact or a log.
7. Leave `recover: 'agent'` as it is; see `overview.md` *Risks*.

## Tests
- `packages/scraping/src/egress.test.ts`: fake driver records `init.proxy`; the HTTP leg uses it.
- `packages/scraping/src/cdp-resolver.test.ts`: `release` runs once on success, throw and abort.
- `packages/scraping/src/usage.test.ts`: counts over the fixture driver; `browserCost` is `Money`.
- `packages/scraping/src/session-seal.test.ts`: stored bytes contain no cookie value.
- `packages/scraping/src/event-prompt.test.ts`: answered, timed out, aborted; the session stays
  open across the wait.
- `packages/scraping/src/session.job.test.ts`: the package's first opt-in suite — two runs on one
  key against the pg driver, the second refused.
- Command: `bun test packages/scraping/src/egress.test.ts`.

## Done when
- One `scrape()` declares `egress`, a resolver, keyed concurrency, `auth.persist` and
  `eventPrompt`, and runs green on the fixture driver with a `usage` block in its report.
- `packages/scraping/CLAUDE.md:60` no longer lists `SessionInit.proxy` as unread.
