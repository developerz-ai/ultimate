# 31 — The maintainer platform: what this repository needs from it

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-core.md) C1 for P1. **Another repository**: each row is an issue (and, where the executor has access, a PR) there, from its own checkout. Nothing here is fixable from this tree.

## Files to change
None here. Observed in this repository's history, As of 2026-11-14:

| # | Ask | Evidence |
|---|---|---|
| P1 | route a production error to the framework's repository when its code is a framework `X_*` code or its top frame is under `@ultimat3/*`, keyed by the `framework_version` tag | a tracker project maps to one repository only; zero tracker-originated issues here |
| P2 | a per-repository schedule that upgrades the framework after a release (`x upgrade`, gate, PR, merge) | no adopter is upgraded automatically; they exclude the framework from dependency automation "bumped by hand" |
| P3 | retry triage after a provider failure without waiting for a new comment | one issue stalled that way; #1104 sat two days with no comment |
| P4 | stop chasing a moving base: rebase once CI is otherwise green, or queue | one PR took 21 reviews then asked for a human |
| P5 | main-red repair must not take hours | two repairs (one 6 h 46 m, 201 tool calls) closed as superseded |
| P6 | clear a latched alarm when its condition is false | #1096 |
| P7 | security items: a per-repository option to act without a person, or state it as the one human dependency | always escalated; one advisory PR was replaced by the owner |
| P8 | releases: the weekly release-due run must open the bump PR itself | every `chore: release` PR to date was the owner's |
| P9 | survive its own dependencies: a fallback model when one is retired, runner Bun at the framework's floor, merged runner code reaching the fleet | open issues on each in that repository |
| P10 | the database tools reach the framework apps' databases once [`30`](30-infra.md) I1 lands (register the database names on the connection) | built, not pointed at these databases |

## Steps
1. File P1–P10 with the evidence above, generic wording, no adopter names.
2. Where a row is configuration in this repository (`.dz/maintainer/maintainer.yml`), make it here in [`12`](12-maintainer-loop.md) instead.
3. Re-measure after each lands: the 30-day window in [`overview.md`](overview.md) *Done when* is the acceptance test for this slice.

## Tests
- A staged drill for each loop, run on a scratch branch or a throwaway issue in this repository: a planted red `main` on a fork-like branch, a planted outside-style issue with a repro bundle, a planted advisory. Record time to repair.

## Done when
- Each of loops 1–7 (outside issue, outside PR, main red, dependency or advisory, scheduled briefs, production error, adopter upgrade) has one recorded run with no owner action.
