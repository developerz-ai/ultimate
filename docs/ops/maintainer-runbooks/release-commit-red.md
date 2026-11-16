# A release commit is red

**A stamped version whose release commit failed CI is never forced out: fix it, and the next patch
carries it.** The precedent is 31.22.2 — stamped on 2026-11-14, its CI red, never tagged or
published; 31.22.3 shipped everything in it (`docs/changelog/31.22.3.md`).

## Notice

| Signal | Command | Red means |
|---|---|---|
| the stamped version is tagged | `bun run scripts/release-due.ts --json` | `data.reason` is `awaiting_tag` and stays so past the release commit's CI run |
| the release commit's run | `git log origin/main --format='%H %s' --grep '^chore: release ' -n 1`, then `bun run x -- ci --run <run-id> --json` | a `conclusion` other than `success` on the release commit |
| nothing went out | `npm view @ultimat3/core@<version> version` | prints nothing: the version is not on npm |

`release-tag.yml` cuts only when `ci.yml` concluded `success` on the push of the release commit
(`scripts/lib/release-subject.ts` matches its subject). A red run leaves no tag, no Release, no
publish — the safe state. Nothing is half-shipped yet.

## Do

| The run died of | Do |
|---|---|
| the runner: `cancelled`, `timed_out`, `startup_failure`, a lost runner or a registry outage in install, with no test step failed | `gh run rerun <run-id> --failed`, once — PUBLISHING.md § Ongoing releases, step 2: it fires `release-tag.yml` again for that commit |
| a test, a lint, a typecheck — anything [`main-red.md`](./main-red.md) would fix | treat it as `main` red. Fix forward on `main`. Then the next bump — `bun run scripts/release.ts --bump patch --dry-run --json`, then without `--dry-run` — stamps the next patch, and its changelog section opens with `Carries <version>, which was stamped but never published (its release commit's CI was red)` |

The skipped version stays in `docs/changelog/` with no tag. The tag walk tolerates up to two such
sections (`MAX_UNTAGGED_SECTIONS`, `scripts/lib/release-tag-walk.ts`); a third is refused.

Verify the carrier shipped: `bun run scripts/registry-audit.ts --json` is `ok`, and
`gh release view v<next-version> --json tagName,isDraft,publishedAt` shows a published Release.

## Never

- Tag the red commit by hand. `release.yml`'s `check` job reads `ci.yml`'s verdict on the tagged
  commit and refuses it anyway; the tag would be a squatted one ([`tag-squatted.md`](./tag-squatted.md)).
- Re-stamp the same version on a new commit. A version number names one tree.
- Rerun a run whose test step failed. A pass on rerun is a flake that just shipped.
