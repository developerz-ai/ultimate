# 16 — the two tracked apps

> Part of [`overview.md`](overview.md). Depends on: 11 (l, m), 12 (b). Paths: `examples/dummy/`, `dummy/social-media-clone/`, `scripts/reference-app-gate.ts`, `scripts/lib/gated-apps.ts`.

Rule: a pin's text states the cause the gate reports today. A tracked app uses the framework's
feature, never a workaround for a gap that has since closed.

Measured 2026-09-23 with `bun run scripts/reference-app-gate.ts --json`, 3m51s, exit 0:
- `examples/dummy`: 19 of 20 green. `budgets` is pinned.
- social clone: 18 of 20 green. `boundaries` and `budgets` are pinned.

## Files to change

| # | Defect | File:line | Change |
|---|---|---|---|
| a | the gate runs only `x verify`, while each app's `bin/check` builds first (`x build --target static`), so `budgets` measures a missing file | `scripts/reference-app-gate.ts:41,369` | Run `x build --target static` before `verify` per app (the `scaffold-smoke` shape) |
| b | the `examples/dummy` `budgets` pin text is stale. It names `X_ENV_MISSING`/`X_NO_CONTEXT`; the truth is `X_CLIENT_TRANSPORT_FAILED` (a build-time query over HTTP) and `X_ACTOR_UNRESOLVED`. The "seventh finding", `X_LIVE_ROUTE_NO_ISLAND`, was fixed 2026-08-25 | `scripts/lib/gated-apps.ts:32-48` | After a and 11 m, re-run. Unpin with `--unpin examples/dummy:budgets` if green; otherwise rewrite the text from the report |
| c | the social clone's `boundaries` red is `site/feed/page.tsx:12` importing `app/posts/service`. 11 pages are `export async function Page` with comments claiming "a route has no `load` seam" (false: `packages/render/src/route.ts:86`) | `dummy/social-media-clone/apps/web/site/feed/page.tsx:4-12`, `app/friends/page.tsx:7-9`, messages, notifications, 5 admin pages | Move each read into `load:` calling a public `query`. Move `feedForPage` to `shared/` (next to `shared/visibility.ts`) or behind a query. Unpin `boundaries`. 11 l's `X_ROUTE_ASYNC_PAGE` keeps it that way |
| d | auth actions return `next` as data, citing "an action cannot answer a form POST with a 303". It can (`packages/action/src/http.ts:91-96`) | `dummy/social-media-clone/apps/web/api/auth.ts:94,123,160`, `auth.contract.test.ts:48` | Return the redirect; update the contract test |
| e | stale comment: "the framework has no client bundler yet" | `dummy/social-media-clone/apps/web/app/friends/ui/respond-form.tsx:3` | Delete it |
| f | the stale untracked `examples/dummy/.x/static-report.json` makes local gate runs read different inputs from CI | `scripts/reference-app-gate.ts` | Clear `.x/static*` before building (row a) |
| g | both apps import `runRole` from the `@ultimat3/cli` barrel | `*/apps/web/server.ts` | Switch to `@ultimat3/cli/serve` (12 b) |
| h | `examples/dummy/apps/admin/README.md` documents `x dev --app admin`, "20 lines", and three `DefineAdminInput` keys that do not exist. `examples/dummy/README.md:114` cites `X_SW_HAND_EDITED` (reserved, never thrown) and a non-existent `public/` | listed | Rewrite from the real `index.ts`; delete the row |
| i | the social app's `APP_URL` defaults to `http://localhost:3000` and is accepted in production. An unset `HCAPTCHA_SECRET` silently selects the null verifier in production | `dummy/social-media-clone/app.config.ts` env schema | Both required when the environment is `production` (the schema's env-conditional form) |
| j | the demo declares live queries and channels (`app/messages/live.ts`, `notifications/topics.ts`) with `realtime: { transport: 'memory' }`, which cannot work across the deployed pods | `dummy/social-media-clone/app.config.ts` | Set the transport the deploy uses (after 18 m decides what the key means). Slice 19 deploys sync, NATS and the replicator |

## Steps
1. a and f, then re-run to get the true reds.
2. c and d on the social clone (after 11 l lands, so the new rule stays green).
3. b: unpin or rewrite.
4. g, e, h.

## Tests
- `bun run scripts/reference-app-gate.ts`
- `bun run scripts/reference-app-gate.ts --unpin <app>:<step>` for each step that went green (the gate demands it via `X_REFERENCE_APP_PIN_STALE`).

## Done when
- The social clone has no `boundaries` pin.
- Every remaining pin's text quotes the code the gate reports.
- No page in either app is an async `Page`.
