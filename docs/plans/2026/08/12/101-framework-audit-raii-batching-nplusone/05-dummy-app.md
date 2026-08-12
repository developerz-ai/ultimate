# 05 — Reference app (`examples/dummy`)

> Part of [`overview.md`](overview.md). Depends on: 02 (query HTTP projection), 07 (preload/join replaces the phantom API). Tier: app-level.

The app's primitive usage is idiomatic (all eight present, `llm()` factory included). The work is:
fix real bugs, exercise the unexercised packages, and shrink the `EXPECTED_RED` ratchet as
framework slices land.

## Bugs

- **Queries called off an actions-only client.** `apps/web/shared/client.ts:38` is `rpc<Api['actions']>` — `queries` is a separate key (`packages/action/src/define-api.ts:59-63`). Broken call sites: `app/posts/[id]/page.tsx:24`, `site/blog/page.tsx:26`, `site/blog/[slug]/page.tsx:26,30`. Fix after 02 mounts the query route: a typed query client alongside the action client.
- **Missing required inputs.** `app/posts/[id]/page.tsx:24` omits `orgId` (required, `app/posts/live.ts:47`); `app/feed/page.tsx:75` omits `orgId` on `LikeButton` (required, `app/posts/ui/like-button.tsx:21`).
- **Wrong row shape rendered.** `site/blog/page.tsx:56` feeds `{slug, updatedAt}` rows to `toCardPost` (needs title/excerpt/status/…, `packages/ui/src/post-card.tsx:57-66`); `site/blog/[slug]/page.tsx:42` reads `updatedAt` off `PostView` which excludes it (`app/posts/entity.ts:20`).
- **UUID rendered as a name.** `app/posts/mail.ts:24` and `app/digest/mail.ts:29` pass `orgId` into the `{org}` mail slot. Load the org name (a `preload`/relation case once 07 lands).
- **Hardcoded strings.** `site/page.tsx:25` (`'Postly'` in JSON-LD; `common.appName` exists), `site/blog/page.tsx:33-34` (breadcrumbs), `site/page.tsx:28` + `site/pricing/page.tsx:31` (`priceCurrency: 'USD'` on a page whose currency is a URL param).
- **Retry-unit bugs in jobs.** `app/posts/jobs.ts:35-37` — send loop *inside* one `step.run('send')`: failure on recipient 40/50 re-sends all 50. Make the step per recipient (or batch send). Same shape in `app/digest/jobs.ts:31-39` (enqueue loop inside one step replays the zone).
- **Cross-job N+1.** `app/digest/jobs.ts:26` loads all recipients, then each `deliverDigest` re-reads its member row (`:70`) and re-queries the same post window per member (`:79`). Pass the needed member fields in the payload; share the post window per (org, zone).
- **The phantom repo API.** `app/posts/repo.ts:6-19` documents that `.join()`, `.with()`, `.returning()`, `.onConflictDoNothing()` don't exist — every function using them throws. After 07: rewrite on the real `preload`/`insertAll`/`upsertAll` surface. This is the source of the 227 pinned typecheck errors.

## Unexercised packages

- `@ultimat3/flags` — zero usage anywhere. Add one flag guarding a visible feature (e.g. the digest), read via `ctx.flags`.
- `@ultimat3/storage` — only `ensureBucket` (`app/orgs/service.ts:98`). Add an upload + signed URL round trip (avatar or post image).
- `@ultimat3/auth` — only indirect `ctx.auth`. Add a visible sign-in flow (session issuance + a guarded page); if the framework surface is missing a piece, build that piece first — the app demonstrating auth is the acceptance test for auth being demonstrable.
- `route` never uses `stream` render; `mutator` demonstrates one conflict strategy of three. Add one of each where natural.
- `apps/desktop/README.md:8` documents `x app add desktop` — not one of the 34 commands. Fix the README (or drop the placeholder).

## README contradictions (`examples/dummy/README.md`)

- `:31` claims `liveFeed` has `persist: true` — it doesn't (`app/posts/live.ts:31-43`).
- `:38,40` claim two routes are `stream` — both are `ssr` (and `app/feed/page.tsx:2-4` explains why it must not be `stream`).
- `:29` claims per-tenant concurrency — `packages/jobs/src/job.ts:50` types `concurrency` as a bare `number`; not expressible. Fix the README now; per-key concurrency is a framework feature to consider separately.

## The ratchet (`scripts/reference-app-gate.ts:41-58`)

7 pins. As work lands, pins must shrink (`X_REFERENCE_APP_PIN_STALE` enforces it):

| Pin | Lifts when |
|---|---|
| `typecheck` (227 errors) | 07's real preload/bulk-write API + this slice's rewrite; then add `./examples/dummy` to root `tsconfig.json` references (else `X_REFERENCE_APP_UNREFERENCED`) |
| `boundaries` | the three `site/` routes importing `@postly/db` (`site/blog/page.tsx:7`, `site/blog/[slug]/page.tsx:9`, `site/pricing/page.tsx:7`) move to queries via the 02 client |
| `contract`, `live`, `job`, `e2e` | the unscoped-repo writes are rewritten on the real API |
| `drift` | regenerate migrations against the current entity set (`x db gen`) |

## Tests

- The app's own gate: `bun run scripts/reference-app-gate.ts` — green means pins shrank correctly, not that everything passes.
- New N+1 demonstration case for 08: a posts→authors loop written the naive way in a test fixture, asserted to trigger the detector, then the `preload` form asserted quiet.

## Done when

- All call-site bugs fixed; flags/storage exercised; README truthful; every lifted pin removed from `EXPECTED_RED`; `bun run scripts/reference-app-gate.ts` and `bun run verify` green.
