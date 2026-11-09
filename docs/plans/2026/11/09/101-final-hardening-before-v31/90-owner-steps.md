# 90 — Owner steps: outward-facing, not for an agent alone

> Part of [`overview.md`](overview.md). Each is a setting, a signature or a fact only the owner holds. Ask once, batch them.

| # | Step | Command / where | Unblocks |
|---|---|---|---|
| O1 | Give N: how many apps run Ultimate in production, and how many are medium-to-large | reply in the run | [`27`](27-trust-docs.md) |
| O2 | Require the `verify` check on `main` (the `main-protection` ruleset) | repo settings | trust, safety of bot merges |
| O3 | Secret scanning + push protection + Dependabot security updates | `gh api -X PATCH repos/developerz-ai/ultimate -F security_and_analysis[secret_scanning][status]=enabled -F security_and_analysis[secret_scanning_push_protection][status]=enabled -F security_and_analysis[dependabot_security_updates][status]=enabled` (admin token) | [`24`](24-ci-gate.md) G7 |
| O4 | CodeQL default setup | `gh api -X PATCH repos/developerz-ai/ultimate/code-scanning/default-setup -f state=configured -f query_suite=default` | trust |
| O5 | Sign `GOVERNANCE.md` (`:3`, `:78`) | edit + commit by the owner | trust |
| O6 | Docs site live: set `DOCS_SITE_ORIGIN`, DNS; point repo `homepage` at it | repo variables, DNS | trust; `deploy-docs-site` stops skipping |
| O7 | Enable GitHub Discussions | repo settings | support surface |
| O8 | Mint a read-only GlitchTip API token into the infra `.env` (`GLITCHTIP_API_TOKEN`) | GlitchTip UI | [`26`](26-infra.md) F4 |
| O9 | Approve a SAML build-vs-wrap call if the slice proposes a dependency | PR review | [`23`](23-feature-gaps.md) |
| O10 | Dispatch `bench.yml` once | `gh workflow run bench.yml` | [`27`](27-trust-docs.md) |
| O11 | Decide adopter F: walk 19 → 31 or re-scaffold | reply | [`45`](45-adopter-f.md) |
