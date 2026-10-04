# 01 — Security: authz, scopes, abuse limits

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2–5. **Sweep 1 — lands first.**
> Every row proven by a probe at `d7b8c7fa` (24.0.0) unless marked *read*. As of 2026-10.

## Rule
A control enforced on one surface is enforced on every surface (axiom 2), or the build refuses.
Fail closed: an unlisted tool, an unverified address, an out-of-scope token → no access, no oracle.

## Agents (≤ 4, disjoint)
| Agent | Exclusive paths |
|---|---|
| A — mcp/http scopes (S1, S2, S13) | `packages/mcp/src/{scopes,registry,app-tools}.ts`, `packages/http/src/{bearer-mount,forwarded}.ts` + tests, `wiki/Deployment.md` (S13 note) |
| B — action/ai limits + leaks (S4, S6) | `packages/action/src/{invoke,http}.ts`, `packages/ai/src/{tools,hive-pool}.ts` + tests, `wiki/Actions.md` |
| C — auth (S3, S5) | `packages/auth/src/{oauth-login,session,privileges}.ts` + tests |
| D — S7–S12 | `packages/storage/src/{upload,driver-s3,driver-local}.ts`, `packages/scraping/src/robots*.ts`, `packages/cli/src/{runtime-assets,role-sync}.ts`, `packages/realtime/src/{sync-upgrade,live-query-options}.ts`, `packages/jobs/src/webhook.ts`, `scripts/fix-shell-arg.ts`, `wiki/Scraping.md` + tests |

Coordinator only: `wiki/Error-Codes.md`, `CHANGELOG.md`, `wiki/Known-Gaps.md`, `framework.manifest.json`.

## Findings → fix

| # | Sev | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| S1 | High | `packages/mcp/src/scopes.ts:69`, `registry.ts:297` | With `scopes:` set, a tool the map does not name has **no** scope gate — a `posts:read` token ran unlisted `deleteAccount` (`{"ok":true}`). `bearer-mount.ts:173` fails closed on the same map. `include: 'exposed'` (`app-tools.ts:206`) makes this the normal case; `scopes_supported` omits these tools, so OAuth consent never names them | When `scopes` is given, every projected tool must be covered: refuse at `defineAppMcp` with a new `X_MCP_SCOPE_UNCOVERED` (`bun run new-error-code X_MCP_SCOPE_UNCOVERED --package mcp --off-socket …`; fix: list the tool under a scope). Mirror `bearer-mount.ts:173` | `packages/mcp/src/scopes.test.ts`: unlisted tool + `scopes` → throws; cross-surface test: same map through `bearerMount` and `defineAppMcp` exposes the same set |
| S2 | High | `packages/http/src/bearer-mount.ts:178` | Scope check sits in the handler; `body` + `authz` stages run first → out-of-scope token gets 422 with the schema issue, or 403 with the policy reason, instead of 404 | One `authenticate` closure per mounted route capturing its `scope`; after `resolveToken`, `throw routeNotFound(...)` when `!caller.scopes.has(scope)`. The `auth` stage (`stages.ts:259`) runs before `body`/`authz`; per-route authenticators already replace the app's (`stages.ts:255`) | `bearer-mount.test.ts` "an out-of-scope token is 404 even with an invalid body or a denying policy" |
| S3 | High | `packages/auth/src/oauth-login.ts:156-196` via `resolveUser:214-217` | First OAuth sign-in with `emailVerified: false` creates a user owning that address → pre-hijack: owner's `register()` refused, verified-provider login refused (`:226`), attacker identity stays linked. Breaks the file's own rule `:205-207` | Unverified provider address never creates an account: answer `loginFailed()` (same as `:221`) | `oauth-login.test.ts` "an unverified provider address never creates an account" → `X_UNAUTHENTICATED`, no user, no account |
| S4 | Medium | `packages/action/src/http.ts:175`; `mcp/src/projectable.ts:84-86`; `ai/src/tools.ts:109`; `.job()`; live subscribe | `rateLimit:` is HTTP-only. Probe `limit: 2`: HTTP `200,200,429,429`; ten MCP calls all `200`. In-app agent: unlimited | Spend the declared bucket inside `invoke` (actor → org → IP) via `toBucket` + `RateLimitStore` from `@ultimat3/http` (tier 2 → action tier 3: legal). Drop the HTTP-only branch so there is one enforcement point. Update `wiki/Actions.md:33` | One declared action; refused after the limit on HTTP, MCP, agent tool, `.job()` — `packages/action/src/rate-limit-surfaces.test.ts` |
| S5 | Medium | `packages/auth/src/session.ts:188-200` (`rotateSession` → `createSession`, `:116`) | Rotation resets `absoluteExpiresAt` + `createdAt`; repeated `updatePrivileges` (`privileges.ts:66-68`) keeps a session alive forever; `revokeSessionsCreatedBefore` misses rotated sessions; cookie `Max-Age` restarts | `createSession` takes optional inherited `absoluteExpiresAt`/`createdAt`; `rotateSession` passes the old ones; cookie `Max-Age` from remaining lifetime | `session.test.ts` "rotation keeps the absolute ceiling" (frozen clock, rotate at day 6/29, expire at original ceiling) |
| S6 | High | `packages/ai/src/hive-pool.ts:79-89` (`failureOf`) | Member failure returns raw cause: 5xx `X_INVARIANT` cause and foreign `.message` (pg `Key (email)=(ceo@corp.com)`) ship in the action's 200 answer. `tools.ts:211-223` (`describeFailure`) hides the same thing | Reuse the `describeFailure` rule: `statusFor(code) >= 500 && !hasPublicCause(code)` → hidden reason; uncoded → fixed reason; log the full cause. Extract one helper both call (no second rule) | `hive-pool.test.ts` "a 5xx member cause and a foreign message are withheld" |
| S7 | Medium | `packages/cli/src/role-sync.ts:162`; `realtime/src/live-query-options.ts:38`; `sync-upgrade.ts:123-168` | One actor fills the node's 10,000 live-query windows (≈79 sockets × 128 subs); everyone else gets `X_SUBSCRIPTION_LIMIT`. No per-tenant / per-actor cap, nothing configurable. *read* | Expose `maxPerTenant` + per-actor socket ceiling via app config (`core/src/config-*.ts`), passed into `LiveQueryRegistry` and `handleUpgrade`. Pattern: bearer mount per-token bucket | `realtime/src/live-query.test.ts`: one actor cannot push `entries.size` past its share |
| S8 | Low | `packages/cli/src/runtime-assets.ts:149`; `storage/src/image.ts:110-118` | `/media` amplification guard checks `?w=` only; `?q=1..100 × f=` → 400 stored variants per source per width | Store only when `quality` is undefined or the framework-minted default (same shape as `isMintableWidth`) | `runtime-assets.test.ts`: `?q=37` → 200, variant not stored |
| S9 | Medium | `packages/scraping/src/robots-fetch.ts:85,164`, `robots.ts:166-167` | 5xx / network error / timeout on `/robots.txt` → allow-all, cached for the run. RFC 9309 §2.3.1.4: MUST disallow. `wiki/Scraping.md:184` repeats the error | `RobotsFetch` answers `text \| 'unavailable' \| 'unreachable'`; 4xx → no rules; 5xx/unreachable → disallow `/`, not cached (or short TTL). Fix the wiki line | `robots-fetch.test.ts`: 503 and thrown fetch → `X_SCRAPE_ROBOTS_DISALLOWED`; 404 → allowed |
| S10 | Medium | `packages/jobs/src/webhook.ts:369-375` | Header object spread keeps case-variant keys; `Headers` joins them → endpoint row `Host`/`Content-Type`/signature become `"evil.test, h.test"` etc. Comments `:367-372` false | `const h = new Headers(endpoint.headers)` then `h.set()` each framework header (pattern: `auth/src/oauth-route.ts:191`) | `webhook.test.ts` "endpoint headers in any case cannot alter host, content-type or the signature" |
| S11 | Low | `packages/storage/src/upload.ts` (`sniffText`, `TEXT_FAMILY`) | XHTML-namespace XML with `<script>` accepted as `application/xml` → stored XSS from app origin | Classify XML whose root is XHTML/SVG namespace (whole doc) as `text/html`/`image/svg+xml`, or drop `application/xml`/`text/xml` from `TEXT_FAMILY` | `upload.test.ts` "xhtml-namespaced xml is not accepted as application/xml" |
| S12 | Low | `packages/storage/src/driver-s3.ts:672,706`, `driver-local.ts:332` | `fix:` lines interpolate key/prefix/bucket/path into shell commands unscreened; `isSafeKey` accepts `$(…)`. Guard `scripts/fix-shell-arg.ts` misses them (prose exemption) | Wrap in `renderFixShellArg(value, '<key>')` like `driver-s3.ts:555,573`; tighten the guard's exemption so these sites are scanned | `driver-s3.test.ts` refusal fix screens key; `scripts/fix-shell-arg.test.ts` catches the prose form |
| S13 | Low | `packages/http/src/forwarded.ts:98-105` | XFP read at XFF index; with `TRUSTED_PROXY_HOPS=2` and an overwriting proxy → `ctx.https` false → no HSTS, `http://` self-origin. *low confidence* | When XFP list is shorter than `hops`, take the last value written by a trusted hop; document append vs overwrite in `wiki/Deployment.md` | `forwarded.test.ts` hops=2, single XFP value |

#591 (idempotency plaintext) is a data-at-rest leak but needs owner choice → [`02-data-integrity.md`](02-data-integrity.md) D7.

## Steps
1. Branch `fix/sweep-1-security` from fresh `main`. Brief A–D with the table rows they own + the paths above.
2. Each agent: failing test first, then fix; `bun test <own files>`; `bunx biome check <own files>`.
3. Coordinator: register `X_MCP_SCOPE_UNCOVERED` (one `new-error-code` run), CHANGELOG `[Unreleased]` rows (S1, S4 are behaviour changes: minor; an app with an unlisted tool now fails to boot → call it out under **Changed**), `bun run manifest`, `bun run verify`.
4. Before opening the PR: run `security-auditor` **and** `concurrency-auditor` read-only over the diff (high-stakes rule, [`overview.md`](overview.md) § Review).
5. PR `Sweep 1 — security`, CI green, agent reviews addressed, merged.

## Done when
- S1–S13 each have a test that fails on `d7b8c7fa` and passes after.
- `defineAppMcp` with an uncovered tool refuses with `X_MCP_SCOPE_UNCOVERED`; MCP and bearer mount expose identical sets.
- `bun run verify` green; PR merged.
