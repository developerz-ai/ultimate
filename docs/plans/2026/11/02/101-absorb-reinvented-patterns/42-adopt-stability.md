# 42 — Adoption: a stability promise, and slower majors

> Part of [`overview.md`](overview.md). Depends on: [`22-cli-upgrade`](22-cli-upgrade.md) (one hop per run makes a window usable). Sets the release schedule. Tier: `scripts/`, CI, docs.

## Why
The largest single blocker for a stranger, and our own adopters already vote: all six surveyed sit behind latest.

| Measured, npm and `wiki/Upgrading.md` | Figure |
|---|---|
| majors | 29 in 78 days (2026-08-11 → 10-28) |
| first 17 days | 19 majors |
| since 2026-09-08, after the bursts | 10 in 50 days: one every 5 days |
| breaking entries, per-hop rows | 528; 23→24 alone is 202; `grep -c BREAKING` in `CHANGELOG.md`: 417 |
| whole majors with at most 2 entries | 9 of 28 hops; 28 and 29 are each a Bun floor plus one other line |
| `CHANGELOG.md` | 1,010,748 B. A Release body is the raw section: 5,026 chars for 29.4.0, no summary |
| support | `SECURITY.md:5-10`: latest major only. On a 5-day cadence, a fix can mean 2 majors of migration |
| deprecation | none. `recordDeprecatedCall` itself was removed (`wiki/Upgrading.md:255`); no notice period exists |
| who decides | `README.md:396`, `.dz/maintainer/maintainer.yml:114`: a breaking change is "the bot's call"; nothing limits how often |

Most of those majors were honest fixes. The fault is not the count of breaks; it is that each ships alone.

## Release schedule
| Release | When | What |
|---|---|---|
| v30 | by 2026-11-30 | the security batch |
| v31 | when ready, with this slice merged first | corruption, outages, rendering and DX, core mechanisms. **The 90-day clock starts here and `next` is cut** |
| v32 | v31 + 90 days | everything else breaking, including all 38–41 breaking rows |
| v33 | v32 + 90 days | any row late for v32 |

- Two close majors, v30 and v31, are legal only because the clock starts at v31. `wiki/Stability.md` says so.
- Minors ship weekly from `main` between majors. A slice with both kinds of change splits into two PRs.
- After v31, a security fix is a patch on `release/31.x`. Only a fix that cannot be non-breaking takes the major exception.

## Decisions
| Question | Decision | Rejected, why |
|---|---|---|
| Major cadence | from v31, at most one per 90 days, on a published date. Refused by `scripts/release.ts`, not by a person, so autonomy holds | semantic loosening: redefining "breaking" to lower the count is gaming; the semver rule in `overview.md` stands |
| Where a break waits | a `next` branch, cut at v31. `main` stays minor and patch, so fixes keep shipping weekly. `next` merges `main` weekly, publishes dist-tag `next` | a config flag per future default (a second path per break, axiom 1) |
| Exception | a security fix that cannot be non-breaking: `--bump major --security <advisory-id>`, the same first-tier rule as `.dz/briefs/release-due.md` | "critical bug" exception: it would be used every week |
| Support window | current major, plus the previous major for security fixes until 6 months after its successor ships. Branch `release/<major>.x` cut at each major and kept at the major's latest minor, so a patch is `latest` while that major is current and `maint-<major>` once its successor ships | a separate LTS line: with quarterly majors the window already spans two, and a third line is gate time nobody funds |
| Deprecation | a removal or rename ships its alias with `@deprecated` on `main` at least one minor before the major takes it. New gate verdicts wait on `next` | runtime deprecation logging: was deleted once for good reason |
| Bun floor | moves only in a scheduled major, or by the security exception | |
| When the clock starts | at v31, per the schedule above | starting now: this plan's breaks would all queue behind 90 days, with live holes |
| Version number | keeps counting. No renumber or reset | a reset rewrites every link and tells a stranger nothing |
| Promise wording | what is covered and what is not, in one page. Never "stable forever" | |

## Files to change
- `wiki/Stability.md` (new), `wiki/_Sidebar.md`, `wiki/Home.md`, `wiki/FAQ.md` — the promise: covered surface (primitive shapes, `x` CLI and `--json`, `X_*` codes, tier table, documented exports), not covered (undocumented exports, `.x/`), cadence, next date, window table, and why v30 and v31 sit close.
- `SECURITY.md:5-10` — the window.
- `README.md:396-398`, `docs/architecture/19-cutting-a-major.md`, `PUBLISHING.md`, `.dz/briefs/release-due.md`, `.dz/maintainer/maintainer.yml:12,114` comment — the bot's call now sits inside the window.
- `scripts/release.ts:195-202` + test — the window check; `scripts/lib/release-due-rule.ts:35,242` — `major_needs_a_maintainer` becomes "next window on <date>".
- `scripts/deprecation-window.ts` (new) + test — removal without prior `@deprecated`; `scripts/verify.ts:343` host check.
- `.github/workflows/release.yml:290` — `npm publish -w "$name"` has no `--tag`, so a maintenance release would move `latest`; derive the tag from the branch.
- `.github/workflows/release-tag.yml`, `ci.yml` triggers — `next`, `release/*`. `scripts/registry-audit.ts:189` — audits `latest` and each open `maint-*`.
- `scripts/changelog-check.ts` + test, `CHANGELOG.md` head, release body step — Highlights.
- `wiki/Upgrading.md` head — current window; the 29 sections stay.

## Steps
1. Write `wiki/Stability.md` first; the rest cites it.
2. `release.ts --bump major`: compare to the last `vN.0.0` tag date, for a target above v31; v30 and v31 are not refused. Inside 90 days, refuse unless `--security <id>`, which is recorded in the commit and the changelog. `--check` holds the same rule, so a bump PR cannot merge around it.
3. `next`: cut at v31; bot policy targets breaking PRs there. From then, a PR with a `BREAKING —` entry against `main` fails `changelog-check`.
4. `deprecation-window.ts`: diff each package's `src/index.ts` export names against the previous tag; a removed name needs `@deprecated` in that tag, else refuse. Security exception as in step 2. Pin today's state at zero before enforcing.
5. Maintenance: at a major, cut `release/<major>.x`; its CI runs `x verify` only on change. Bump PR on that branch follows the existing "merging it is the release" path, tag `v<major>.y.z`, dist-tag per the support row.
6. Changelog: every release section opens `### Highlights`, at most 5 bullets, user-visible, plain. Release body = Highlights + the Upgrading anchor. The full section stays below. `Unreleased` is exempt until release.
7. At v31, publish v32's date, v31 + 90 days, on `wiki/Stability.md`.

## Error codes
`bun run new-error-code`, `--off-socket`, package `scripts` host.

| Code | When | Fix |
|---|---|---|
| `X_RELEASE_MAJOR_WINDOW` | `--bump major` inside 90 days, no advisory | target `next`; or `bun run scripts/release.ts --bump major --security <id>` |
| `X_BREAKING_ON_MAIN` | `BREAKING —` entry in a PR to `main` | `git rebase --onto next main`, retarget the PR to `next` |
| `X_RELEASE_UNDEPRECATED_REMOVAL` | export gone with no prior `@deprecated` | restore it with `@deprecated`, and remove it in the next window |
| `X_CHANGELOG_HIGHLIGHTS_MISSING` | a release section has no Highlights | add `### Highlights` to that section in `CHANGELOG.md` |

## Tests
- `scripts/release.test.ts`: v31 10 days after v30 passes; v32 10 days after v31 refuses; with `--security` passes; 91 days passes. Fails on today's code.
- `scripts/deprecation-window.test.ts`: fixture tags, removal with and without the tag.
- `scripts/changelog-check.test.ts`; `scripts/registry-audit` fixture with `maint-29`.
- `bun test scripts/release.test.ts`

## Semver
No package change. Policy only. Note in `wiki/Upgrading.md`: from v31, one major per window.

## Done when
- After v31, `bun run scripts/release.ts --bump major --dry-run` refuses inside the window; before it, a fixture for v31 passes.
- A dry-run maintenance publish leaves `dist-tags.latest` unchanged.
- `wiki/Stability.md` states the next major's date and is linked from `README.md` and `SECURITY.md`.
- The next Release body reads in under 30 seconds.
