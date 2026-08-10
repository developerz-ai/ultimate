# Security Policy

## Supported versions

Framework packages move in lockstep, so "supported version" is one number covering all 28 — the 27 `@ultimat3/*` packages and the unscoped `create-ultimate`.

| Version | Supported |
|---|---|
| `1.0.x` | ✅ security fixes |
| `< 1.0.0` | ❌ pre-release, never supported — upgrade |

A fix ships as a patch to every package in one release, on the [same lockstep rule as any other release](PUBLISHING.md). There are no per-package security branches and no backports below 1.0.0. Report against the latest `1.0.x`.

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/developerz-ai/ultimate/security/advisories/new). Do not open a public issue for a vulnerability.

Include: the affected package and version, a reproduction, the impact, and any suggested fix. We acknowledge within 3 business days.

## Security posture of the framework

Design decisions that carry security weight, so you know what to audit:

| Area | Posture |
|---|---|
| **Authz** | One `policy` definition enforced across HTTP, live queries, jobs, and MCP. There is deliberately no second authz system. An `action` without a policy fails at registration. |
| **MCP tool visibility** | Three outcomes, never blurred. A tool the caller's *role* may not invoke is omitted from `tools/list` and answers ToolNotFound — never Forbidden, so there is no enumeration oracle. A tool the *connection's token* lacks the scope for is refused explicitly (`X_MCP_SCOPE_DENIED`), because a well-behaved client can fix that. A tool that ran and whose *policy* denied the input answers `X_FORBIDDEN`, identical to the HTTP answer. Visibility is fail-closed and input-independent: `visibleTo` is either a role allowlist — which admits only the roles it names, so a caller with no matching role is refused — or a predicate over the caller alone, which structurally cannot read call arguments, so existence cannot be probed by varying them. Computed per connection, and every outcome is audited, ToolNotFound at `warn`. |
| **MCP dev server** | `db.query` is read-only in four layers: a SELECT-only Postgres role, `BEGIN READ ONLY` + `SET LOCAL statement_timeout`, a single-read parse (batches, statement-level write keywords including data-modifying CTEs, locking clauses, `EXPLAIN ANALYZE` and `pg_read_file`-class functions are all refused), and caps — `limit` defaults to 100 rows and clamps to a hard maximum of 1000, plus a 256 KiB byte cap. The role layer is conditional: a managed Postgres that refuses `CREATE ROLE`/`GRANT` leaves it out, and the response's `guards` array names the layers that actually engaged. `db.migrate` refuses any database that is not a branch DB. The `/_x` dashboard refuses to mount in production. |
| **Multi-tenancy** | A tenant-scoped entity queried without an org predicate throws `X_TENANCY_UNSCOPED`. It is a runtime guard, not a convention. |
| **Secrets** | Env vars declared `secret` are redacted in logs, traces, and error output. `.env` is gitignored; `.env.example` documents the shape with no values. |
| **Admin** | Every admin mutation is appended to an audit log with actor, before/after diff, and request id. Destructive actions require re-confirmation. |
| **Preview deploys** | A branch environment emits `Disallow: /` in `robots.txt` and scopes its service-worker cache by build ID, so a preview can never poison the production cache. |
| **CSP** | Locked defaults. The theme inline script ships with its sha256 hash so no `unsafe-inline` is needed. |
| **Egress in tests** | Sealed by default. Any unmocked outbound request fails the test. |

## Known gaps

Open at 1.0.0, `As of 2026-08`. None of these is closed by the release; audit accordingly.

- **No third-party security audit.** The auth stack has had no external review. Better Auth binds through `AuthAdapter` rather than being a dependency, so the seam is narrow and swappable — but neither the built-in adapter nor a Better Auth binding has been audited by anyone outside this repo.
- **Rate limiting is per-replica.** `RateLimitStore` is an interface with one shipped implementation, `memoryRateLimitStore()`; the Redis/Postgres store is still interface-only. N replicas therefore enforce N × the configured bucket. Terminate rate limiting at a shared proxy if the limit has to hold across the fleet. The credential-path throttle in `@ultimat3/auth` (per-IP and per-account lockout) has the same per-process scope.
- **The sync protocol has had no adversarial review.** Tiers 1–2 ship; tier 3 local-first (`persist: true`) is deferred to v2, and its OPFS store throws until the browser entry ships — so the untrusted-client exposure is closed by absence, not by review. When tier 3 arrives, the protocol still needs that review first.
