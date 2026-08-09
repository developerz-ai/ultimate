# Security Policy

## Supported versions

Pre-alpha. No version is supported for production use yet, and no security backports exist. Track [the roadmap](docs/idea/14-roadmap.md).

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/developerz-ai/ultimate/security/advisories/new). Do not open a public issue for a vulnerability.

Include: the affected package and version, a reproduction, the impact, and any suggested fix. We acknowledge within 3 business days.

## Security posture of the framework

Design decisions that carry security weight, so you know what to audit:

| Area | Posture |
|---|---|
| **Authz** | One `policy` definition enforced across HTTP, live queries, jobs, and MCP. There is deliberately no second authz system. An `action` without a policy fails at registration. |
| **MCP tool visibility** | Three outcomes, never blurred. A tool the caller's *role* may not invoke is omitted from `tools/list` and answers ToolNotFound — never Forbidden, so there is no enumeration oracle. A tool the *connection's token* lacks the scope for is refused explicitly (`X_MCP_SCOPE_DENIED`), because a well-behaved client can fix that. A tool that ran and whose *policy* denied the input answers `X_POLICY_DENIED`, identical to the HTTP answer. Visibility is fail-closed — `visibleTo` admits only the roles it names, and a caller with no role sees only tools that declare none — computed per connection, and every outcome is audited, ToolNotFound at `warn`. |
| **MCP dev server** | `db.query` is read-only and enforced. `db.migrate` refuses any database that is not a branch DB. The `/_x` dashboard refuses to mount in production. |
| **Multi-tenancy** | A tenant-scoped entity queried without an org predicate throws `X_TENANCY_UNSCOPED`. It is a runtime guard, not a convention. |
| **Secrets** | Env vars declared `secret` are redacted in logs, traces, and error output. `.env` is gitignored; `.env.example` documents the shape with no values. |
| **Admin** | Every admin mutation is appended to an audit log with actor, before/after diff, and request id. Destructive actions require re-confirmation. |
| **Preview deploys** | A branch environment emits `Disallow: /` in `robots.txt` and scopes its service-worker cache by build ID, so a preview can never poison the production cache. |
| **CSP** | Locked defaults. The theme inline script ships with its sha256 hash so no `unsafe-inline` is needed. |
| **Egress in tests** | Sealed by default. Any unmocked outbound request fails the test. |

## Known gaps (pre-alpha)

- Better Auth integration is wrapped but not yet hardened or audited.
- Rate limiting ships an in-memory default; the distributed store is interface-only.
- The sync protocol has not had an adversarial review. Do not expose tier-3 local-first sync to untrusted clients yet.
