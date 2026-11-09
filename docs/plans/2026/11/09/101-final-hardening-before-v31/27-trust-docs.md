# 27 — Trust: what a human or an AI evaluator sees first, and every claim checkable

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md) for the version line (write the rest earlier, flip the version at release). Tier: docs, `scripts/`.

## Why
Measured 2026-11-09 as a skeptical evaluator: the product holds up (quickstart: scaffold 3.3 s, setup 19.7 s, dev ready ~5 s; demo 200; SLSA provenance; 33 bench claims backed). The first impression does not.

| Rank | Signal | Evidence | Fix (in repo) |
|---|---|---|---|
| 1 | "v30 in ~90 days" reads as churn | 20 majors in `CHANGELOG.md`, 135 npm versions since 2026-08-11 | v31 presented as the stable line beside the badge; CHANGELOG preface: 1–30 were pre-stability |
| 2 | README says no production use; FAQ says production ready | `README.md:96` vs `wiki/FAQ.md:9` | one constant `PRODUCTION_APPS = { count: N, sizes: '…' }` rendered into README and FAQ; adopters never named (`scripts/private-names.ts` guard) |
| 3 | dense first screen, no picture | `README.md:62-104` four tables; `:96` one 400-char sentence | new top (below), one screenshot of `/_x` or the demo |
| 4 | no Scorecard / CodeQL / scanning | `gh api repos/developerz-ai/ultimate --jq .security_and_analysis` | Scorecard workflow + badge (here); settings ([`90`](90-owner-steps.md)) |
| 5 | stale benchmarks | results from v21; `bench.yml` cron has never run; `wiki/Stability.md:29` "re-measured each release" is false | dispatch `bench.yml` once, commit results, reword to "weekly by `bench.yml`" |

## Stale or false claims
| file:line | Problem | Proving command |
|---|---|---|
| `GOVERNANCE.md:20` | "no branch protection" — a ruleset exists; required checks are what is missing | `gh api repos/developerz-ai/ultimate/rules/branches/main --jq '[.[].type]'` |
| `wiki/Stability.md:29` | "re-measured each release" | `gh run list --workflow bench.yml` |
| `wiki/FAQ.md:9` | "Yes" to production-ready beside "no production use" | `README.md:96` |
| `llms.txt:5` | `As of 2026-08-20` on a regenerated file | `git log -1 --format=%ci -- llms.txt` |
| `wiki/Known-Gaps.md:25` | old stamp on a daily-checked fact | `bun run scripts/registry-audit.ts --json` |
| `README.md:91` | "0 of 9,028, As of 2026-09-24" — six majors old | latest `deploy-proof` job log; rerun, restamp |
| `SECURITY.md:21` | "acknowledge within 3 business days" names no channel | state who/where (GitHub private advisory) |

## Files to change
- `README.md` — the top (shape below), the production line, links to `wiki/Compared.md` and "when not to pick it" (`README.md:71-78`, add "no outside security audit", "single maintainer org").
- `assets/dashboard.png` (new, ≤ 200 KB).
- `scripts/readme-facts.ts` (+ test): writes a `<!-- facts -->` block (tests run, coverage %, packages, version) from the CI `verify` part; `--check` reds the gate on drift (pattern: `scripts/readme-sample.ts`).
- `scripts/production-apps.ts` (+ test): the N constant and its render into README + FAQ, `--check`.
- `.github/workflows/scorecard.yml` (new; `ossf/scorecard-action` pinned by SHA, `publish_results: true`).
- `CHANGELOG.md` preface; `GOVERNANCE.md:20`; `wiki/Stability.md:29`; `wiki/FAQ.md:9`; `llms.txt` (fix `:5`; add a 5-line "Evaluating Ultimate?" block with the trust commands and a link to `wiki/Adapters.md`); `wiki/Known-Gaps.md:25`; `SECURITY.md:21`; `scripts/bench/results/` (fresh run).

## README top (shape; human first screen, then machine-checkable facts)
```md
<one-sentence what it is, plain language>
[CI] [npm v31] [provenance] [OpenSSF Scorecard] [MIT]
![dashboard](assets/dashboard.png)
**What it is.** Rails' philosophy on Bun + Postgres + SolidJS. Declare an `action` once: HTTP route,
OpenAPI, typed client, job, MCP tool and test, one `policy` guarding all of them.
**Try it** (no Docker): bunx create-ultimate myapp && cd myapp && bun run setup && bun run dev
[live demo] · [docs] · [how it compares] · [when not to use it] · [write your own adapter]
**Status.** v31 is the stable line: at most one major per 90 days ([Stability]). In production in
N apps (adopters are never named). No outside security audit yet ([SECURITY.md]).
**Check every claim** — table: claim → command (npm attestation, scaffold-smoke, readme-facts).
```

## Tests
- `scripts/readme-facts.test.ts`, `scripts/production-apps.test.ts`: drift reds.
- `bun run scripts/bench-claims.ts --json` green after the fresh results.

## Done when
- A cold read of README's first screen answers: what, why, who uses it, how to try, how we know it works.
- Every row in the stale-claims table is fixed or restamped with its command.
