# 24 — Browser failures reach the one `ErrorReporter`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 5 (`cli`).

## Why
An island that throws in production leaves one attribute on one element and nothing else. `render/src/hydrate.ts:139` records `data-x-failed`, and every strategy ends in a no-op catch (`:141`, `:164`), so not even `unhandledrejection` fires. `ERROR_SOURCES` is `http, job, realtime, cli, process` (`core/src/error-reporter.ts:23`). No framework source listens for a window `error` outside realtime and test code. An operator with a working reporter sees a green dashboard while a form is dead.
Four apps of twelve built the same answer: 436 LOC in one (client sink plus guarded route), 218 in a second (mostly noise filters), a controller action in a third, a vendor browser SDK in a fourth. They agree on the doors, window `error` and `unhandledrejection`, and on capping or filtering what leaves. The two without an SDK also agree on forwarding server-side, so the browser holds no monitor credential; one of them adds a body cap and a per-session limit. None of the six adopters on this framework has it; that is the gap, not absence of need.

## Decisions
| Question | Answer |
|---|---|
| Primitive? | none: a framework route like `/_storage`, in `cli`'s route table. Not an `action`: it must not appear in OpenAPI or MCP |
| On by default? | no. `clientErrors: { enabled: false }`. A new public write route is the app's decision, like `pwa.push` |
| Which documents | `app/` only. `site/` stays free of it (axiom 6). The admin ships no script (`admin/CLAUDE.md`), so none there |
| Island failure | a `MutationObserver` on `ISLAND_FAILED_ATTRIBUTE` inside the reporter script, so `hydrate.ts` pays no byte for apps that have it off |
| Anonymous reports | refused by default: crash text is input to whoever reads the monitor, and an open door lets anyone write there. `anonymous: true` for a public `app/` page, rate limited by address |
| Same-origin | required (`sec-fetch-site`, then `origin`); a cross-site page cannot file through a signed-in browser |
| Noise | only `filename` on this origin; `Script error.` with no stack is dropped; at most 5 reports per document and one per distinct message. Not a filter DSL: app rules belong in its wrapped reporter, as one adopter already does |
| Skew | the body carries the page's build id; `meta.clientBuild` beside the server's `release` tells a stale tab from a bug |
| Web vitals on this route | no. Zero adopters collect them apart from a vendor SDK's default; a closed report shape stays closed |
| Source maps | no. The stack is reported as is |

## Files to change
- `packages/core/src/error-reporter.ts:23` — add `browser`.
- `packages/core/src/config.ts:213` — `AppConfig.clientErrors`; new `config-client-errors.ts` with defaults; `{ enabled: false, anonymous: false, perMinute: 30 }`.
- `packages/cli/src/client-errors-script.ts` (new) — emits `/x-client-errors.js`: the two window listeners, the observer, caps, `fetch` with `keepalive`, never throws, never reports its own failure.
- `packages/cli/src/client-errors-routes.ts` (new) — GET script (`revalidatedResponse`, as `sw-routes.ts:45`), POST: origin check, actor check, `memoryRateLimitStore` with `rateLimitDecision` (`http/src/rate-limit.ts:193,266`) keyed on actor or address, 32 KiB cap, strict `t.object` with per-field caps, then `reportError(new ClientErrorReported(…), { source: 'browser' })`. 204 always on acceptance.
- `packages/cli/src/serve-web.ts:136`, `dev-route-table.ts:158` — mount beside `storageRoutes`, only when enabled.
- Head: the `app` surface document, same seam as `serviceWorkerHead` (`sw-artifacts.ts:225`); a static export has no route, so `serviceWorkerWarnings`' shape reports it and emits no tag.
- `packages/cli/src/budgets.ts:296` — `FRAMEWORK_SCRIPTS` gains the path: every `app/` document carries it and no author can remove it; `bun run budget-raises` if a figure moves.
- `examples/dummy/app.config.ts` — enable; `examples/dummy/apps/web/e2e/client-errors.e2e.test.ts` (new).
- `wiki/Observability.md` (new section), `wiki/Configuration.md`, `wiki/Error-Codes.md`, `packages/cli/README.md`, `packages/cli/CLAUDE.md`, `packages/core/CLAUDE.md`.

## Steps
1. `core`: the source member and the config block; test the defaults and `X_CONFIG_INVALID` on `perMinute: 0`.
2. `bun run new-error-code X_CLIENT_ERROR --package core --title '…' --cause '…' --fix 'x shot <route> --json' --off-socket`; the report's `cause` is the capped browser message.
3. Script as a generated string; run it against a stub window in a unit test, as `service-worker-runtime.test.ts` does.
4. Routes, with refusals answered 204-free: 403 cross-site, 401 anonymous, 413 oversized, 429 limited. A refusal is never reported.
5. Mount and head; dummy use and e2e.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CLIENT_ERROR` (new) | the code on every report a browser sent; a monitor groups on it and on the message | `x shot <route> --json` reproduces it in a real browser and names the failed island |

## Tests
- `client-errors-script.test.ts` (unit): each door posts once; a 6th is dropped; a foreign `filename` is dropped; a failing `fetch` does not re-enter.
- `client-errors-routes.test.ts` (unit): each refusal status; an unknown key is 400; the report seen by `memoryErrorReporter` has `source: 'browser'` and `clientBuild`; nothing is reported on refusal.
- `client-errors.e2e.test.ts`: an island whose `mount` throws produces a POST in the request log, the path with no query string. Must fail with the feature off.
- `bun test packages/cli/src/client-errors-routes.test.ts`, `x test e2e`.

## Semver
**Breaking, one row.** `ERROR_SOURCES` is an exported constant and gains `browser`; `ErrorSource` widens, so an exhaustive `switch` on it stops compiling. The feature itself is off by default.
Upgrading: "Add a `browser` arm to any exhaustive `switch` on `ErrorSource`, or a `Record<ErrorSource, …>`."

## Done when
- With it off, no document names the script and the route is a 404; `budgets` figures are byte-identical.
- With it on, a throwing island reaches the configured reporter, within caps, with no credential in the browser.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` are green.
