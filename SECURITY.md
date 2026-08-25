# Security Policy

## Supported versions

Framework packages move in lockstep, so "supported version" is one number covering all 30 — the 30 `@ultimat3/*` packages and the unscoped `create-ultimate`. Re-derive the list with `bun run scripts/release-workflow.ts --json`.

| Version | Supported |
|---|---|
| `3.0.x` | ✅ security fixes |
| `< 3.0.0` | ❌ upgrade — see [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) |

Only the latest major gets fixes. A fix ships as a patch to every package in one release, on the [same lockstep rule as any other release](PUBLISHING.md); there are no per-package security branches and no backports. Report against the version `npm view @ultimat3/core version` answers.

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/developerz-ai/ultimate/security/advisories/new). Do not open a public issue for a vulnerability.

Include: the affected package and version, a reproduction, the impact, and any suggested fix. We acknowledge within 3 business days.

## Security posture of the framework

Design decisions that carry security weight, so you know what to audit:

| Area | Posture |
|---|---|
| **Authz** | One `policy` definition enforced across HTTP, live queries, jobs, and MCP. There is deliberately no second authz system. An `action` without a policy fails at registration. |
| **MCP tool visibility** | Three outcomes, never blurred. A tool the caller's *role* may not invoke is omitted from `tools/list` and answers ToolNotFound — never Forbidden, so there is no enumeration oracle. A tool the *connection's token* lacks the scope for is refused explicitly (`X_MCP_SCOPE_DENIED`), because a well-behaved client can fix that. A tool that ran and whose *policy* denied the input answers `X_FORBIDDEN`, identical to the HTTP answer. Visibility is fail-closed and input-independent: `visibleTo` is either a role allowlist — which admits only the roles it names, so a caller with no matching role is refused — or a predicate over the caller alone, which structurally cannot read call arguments, so existence cannot be probed by varying them. Computed per connection, and every outcome is audited, ToolNotFound at `warn`. |
| **MCP dev server** | `db.query` is read-only in four layers: a SELECT-only Postgres role, `BEGIN READ ONLY` + `SET LOCAL statement_timeout`, a single-read parse (batches, statement-level write keywords including data-modifying CTEs, locking clauses, `EXPLAIN ANALYZE` and whole function families — file access, `pg_advisory_*` locks, `set_config`, `pg_sleep*` — are all refused, by prefix of the called function name — quoted and schema-qualified spellings included — so a spelling nobody listed is refused rather than admitted), and caps — `limit` defaults to 100 rows and clamps to a hard maximum of 1000, plus a 256 KiB byte cap. The role layer is conditional: a managed Postgres that refuses `CREATE ROLE`/`GRANT` leaves it out, and the response's `guards` array names the layers that actually engaged. `db.migrate` refuses any database that is not a branch DB. The `/_x` dashboard refuses to mount in production. |
| **Multi-tenancy** | A tenant-scoped entity queried without an org predicate throws `X_TENANCY_UNSCOPED`. It is a runtime guard, not a convention. |
| **Secrets** | Env vars declared `secret` are redacted in logs, traces, and error output. `.env` is gitignored; `.env.example` documents the shape with no values. |
| **Admin** | Every admin mutation is appended to an audit log with actor, before/after diff, and request id. Destructive actions require re-confirmation. |
| **Preview deploys** | A branch environment emits `Disallow: /` in `robots.txt` and scopes its service-worker cache by build ID, so a preview can never poison the production cache. |
| **CSP** | Locked defaults. The theme inline script ships with its sha256 hash so no `unsafe-inline` is needed. |
| **Egress in tests** | Sealed by default — `sealNetwork()` replaces global `fetch`, and any unmocked outbound request throws `X_TEST_NETWORK_SEALED` naming the URL and the line that allows it. Opting out is an env var (`ULTIMATE_TEST_ALLOW_NET=1`), never an API, so no test file can quietly unseal the network for itself. **One documented exception**: a caller that swallows the refusal defeats the seal, and `@ultimat3/scraping`'s `/robots.txt` read is one — `robotsFetcher`'s `catch { return undefined }` turns "sealed" into "unreadable", which the robots gate reads as allow-everything, so an offline `fakeBrowser`/`fixtureBrowser` scrape attempts one real request per origin and the suite is green either way. Verified 2026-08-19; tracked in [`wiki/Known-Gaps.md`](wiki/Known-Gaps.md). |

## Known gaps

`As of 2026-08-19`. None of these is closed by the current release; audit accordingly. The full defect list, security-weighted or not, is [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **No third-party security audit.** The auth stack has had no external review. Better Auth binds through `AuthAdapter` rather than being a dependency, so the seam is narrow and swappable — but neither the built-in adapter nor a Better Auth binding has been audited by anyone outside this repo.
- **Rate limiting is still per-replica, but a wrong configuration is now refused rather than silent.** `memoryRateLimitStore()` remains the only shipped implementation, so N replicas still enforce N × the configured bucket; the Redis/Postgres store has not been built. What changed: the store and the app each declare a `scope` (`'process' | 'shared'`), `createServer({ rateLimitStore })` reaches the seam through the supported API, and an app declaring `scope: 'shared'` against a per-process store refuses **at boot** — `X_RATE_LIMIT_NOT_SHARED`, and `X_AUTH_LIMITER_NOT_SHARED` for the credential path.

  **The two sides answer a missing `scope` differently, and the HTTP one refuses the boot.** This file said "both default to `'process'`" and that is false for HTTP:

  | Side | No `scope` declared |
  |---|---|
  | HTTP — `resolveRateLimitConfig` | **throws `X_RATE_LIMIT_SCOPE_UNSET`** while the limiter is enabled. `DEFAULT_RATE_LIMIT` is typed `Omit<RateLimitConfig, 'scope'>`, so it structurally cannot carry one. Defaulting made "we did not ask" indistinguishable from "the app said one replica", and the chart's `replicas: 3` then enforced every number three times over, silently. `enabled: false` reads as `'process'` — a limiter that is switched off has nothing to be wrong about |
  | Credentials — `DEFAULT_AUTH_RATE_LIMIT` | defaults to `'process'`. Per-IP and per-account lockout, one process' worth of state |

  Until a shared store ships, terminate rate limiting at a shared proxy if the limit has to hold across the fleet.
- **The sync protocol has had no adversarial review.** Tiers 1–2 ship; tier 3 local-first (`persist: true`) is deferred to v2, and its OPFS store throws until the browser entry ships — so the untrusted-client exposure is closed by absence, not by review. When tier 3 arrives, the protocol still needs that review first.
