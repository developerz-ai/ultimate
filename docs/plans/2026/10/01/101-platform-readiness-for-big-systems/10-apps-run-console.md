# 10 — Apps: a run console in the reference app

> Part of [`overview.md`](overview.md). Depends on: 01–09. Tier: apps.

Rule: `examples/dummy` shows every primitive once, idiomatically — and today neither tracked app
calls `scrape()`, so the package has no consumer in the tree. This slice is the proof that slices
01–09 compose: a long run, watched live, answered mid-run, one per key.

## Files to change
All under `examples/dummy/apps/web/app/runs/` (new feature slice):

| File | Primitive | What it shows |
|---|---|---|
| `entity.ts` | `entity` | `connection` with a `.sealed()` credential column; `runEvent` rows — `{ runId, seq, kind, at, message }` |
| `policy.ts` | `policy` | who may start, watch and answer |
| `actions.ts` | `action` | `startRun` enqueues the scrape; `answerPrompt` publishes the event; `cancelRun` |
| `jobs.ts` | `job` via `scrape()` | fixture driver, `egress`, keyed concurrency on the connection id with `whenBusy: 'fail'`, `eventPrompt`, one `runEvent` row per phase |
| `live.ts` | `query` (`live: true`) | the run's events, ordered by `seq` |
| `page.tsx`, `run-console.island.tsx` | `route` | `useQuery` live list in `AsyncRegion`, the prompt form, the usage block |
| `run-console.module.scss` | — | tokens and the slice-05 helpers only |

Plus `examples/dummy/apps/web/api/index.ts:51-60` (register the modules),
`examples/dummy/packages/db/src/client.ts:44` (add both entities), the i18n catalog, and
`dummy/social-media-clone` — adopt the slice-06 guards and the slice-05 helpers only.

## Steps
1. Generate, do not hand-write: `bun run x -- g resource run --feature runs --live`, then edit.
   Anything the generator gets wrong here is a finding for slice 08, fixed there.
2. `runEvent` is append-only. Use `appendOnly: true` if plan 102 slice 04 has landed; a plain
   entity otherwise, with a note in `status.yml`.
3. `seq` is allocated by the job per run, monotonic from 1. The console orders and de-duplicates
   on it. The earlier service attempt started at 0 and read `seq > 0`: its first event was
   invisible, and each side's tests agreed with itself.
4. The MCP projection is free: mark `startRun`, `answerPrompt`, `cancelRun` and the live query
   `mcp: { expose: true }`. Write no tool by hand.
5. Machine callers get the same actions over the bearer mount
   (`packages/http/README.md:290-304`) with a key from `issueApiKey`
   (`packages/auth/src/api-keys.ts:64`). No second API.
6. The island's JS is real function. Measure the route, raise its budget by that amount in the
   same diff with the reason (`bun run budget-raises`).
7. Island states file for the console (`island-without-states` guard): pending, streaming,
   awaiting input, failed, done.

## Tests
- `runs.test.ts` (unit): policy matrix; `startRun` twice on one connection → second settles
  `X_JOB_KEY_BUSY`.
- `runs.job.test.ts`: the scrape end to end on the fixture driver — events 1..n in order, prompt
  answered, usage reported, stored session sealed.
- `runs.e2e.test.ts`: the console shows events arriving without a reload; answering the prompt
  resumes the run.
- Command: `bun test examples/dummy/apps/web/app/runs/runs.test.ts`.

## Done when
- `bun run scripts/reference-app-gate.ts` green; `expectedRed` (`scripts/lib/gated-apps.ts`) has
  no new row.
- The feature contains no `fetch(`, no `sql` literal in its repo, no raw length or breakpoint.
- `bun run verify` green, all 20 steps.
