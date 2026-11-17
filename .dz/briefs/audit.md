# Brief: what does this month's audit confirm?

Monthly audit fired every Monday by `schedules: audit` in `.dz/maintainer/maintainer.yml` — the
schema has weekdays, not days of the month. **Act only on the first Monday of the month:**
`[ "$(date -u +%-d)" -le 7 ]`. On any other Monday stop here, file nothing, open nothing.

The audit rounds of plan 101b slice 20 (`docs/plans/2026/11/14/101-finished-and-self-maintained/20-audit-rounds.md`),
continuing after the plan ends: one tier band, one auditor, at most three fix PRs. Read
`CLAUDE.md` first; its axioms and non-negotiables bind every fix.

## Pick the band and the auditor

`m=$(date -u +%-m)`. The band is `(m - 1) % 3`, the auditor `((m - 1) / 3) % 3` — every pair in
nine months.

| Index | Band (tiers, `scripts/lib/tiers.ts`) | Auditor (`.claude/agents/`) |
|---|---|---|
| 0 | tiers 0–1: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` | `bug-hunter` |
| 1 | tiers 2–3: `entity`, `policy`, `http`, `auth`, `action`, `query`, `jobs`, `realtime` | `concurrency-auditor` |
| 2 | tiers 4–6: `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify`, `scraping`, `admin`, `testing`, `cli`, `create-ultimate` | `security-auditor` — one axis, `$(date -u +%Y) % 3`: 0 authz + tenancy, 1 injection + secrets, 2 resource exhaustion + supply chain |

The band is the package list `scripts/lib/tiers.ts` holds at run time; the table above is its
reading on 2026-11-15, never a second copy to trust over it. A confirmed P0 security finding goes
through `SECURITY.md`'s private channel and is the owner's to decide, never a public PR.

## Run

1. Run the auditor over the band, read-only, with this input: open `bug` issues touching the band
   (`gh issue list --state open --label bug --json number,title,url`), and the last `evidence`
   brief's issues (`gh issue list --state all --search 'evidence: in:title' --json number,title,url,createdAt`).
2. **Confirm before fixing.** A finding counts only with `file:line` and a reproduction — a failing
   test, or a command and its wrong output. Unreproduced findings are dropped, never parked.
3. **Grade.** P0 data loss, security, a crash in production; P1 a wrong result or a broken documented
   path; P2 any other real defect. Style is not a finding.

## Fix: at most three PRs

Highest grade first. One PR per finding: the failing-first test (red on `main`, green with the
fix), then the fix, `bun run verify` green, a `CHANGELOG.md` `[Unreleased]` line under `### Fixed`.
A review thread that disagrees: `docs/ops/maintainer-runbooks/review-bot-disagrees.md`.

Findings past the third: one issue each, titled `audit <YYYY-MM>: <finding>`, with the `file:line`
and the reproduction.

## What to file

Nothing confirmed: no PR, no issue; end the run summary with
`audit <YYYY-MM>: nothing found — <band>, <auditor>, <files read>`.

## Rows

- `first-monday` — Stop unless the UTC day of the month is 1-7.
- `band` — Pick this month's tier band and auditor from the month number; read the band's packages from `scripts/lib/tiers.ts`.
- `confirm` — Count a finding only with `file:line` and a reproduction; drop the rest.
- `fix` — At most three PRs, highest grade first, each with a failing-first test and a green `bun run verify`; the rest are issues; a P0 security finding goes through `SECURITY.md`.
