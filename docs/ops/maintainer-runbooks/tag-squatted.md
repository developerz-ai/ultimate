# A tag was squatted

**A `v*` tag that `release-tag.yml` did not create is never moved or deleted by the loop: the
version is burned, the next patch is the release.** `release-tag.yml` stops quietly when the tag
already exists (PUBLISHING.md § Ongoing releases, step 2), so a squatted tag blocks a release
without a red anywhere.

No ruleset covers tags, `As of 2026-11-15`: `gh api repos/developerz-ai/ultimate/rulesets --jq '.[] | {name, target}'`
lists one, `main-protection`, target `branch`. Anyone with write access can push `v*`. The
`npm-publish` environment admits any `v*` tag
(`gh api repos/developerz-ai/ultimate/environments/npm-publish/deployment-branch-policies --jq '.branch_policies[] | {name, type}'`).

## Notice

| Signal | Command | Squatted when |
|---|---|---|
| the tag is annotated | `git ls-remote --tags origin 'refs/tags/v<version>*'` | no `^{}` line: a lightweight tag. `release-tag.yml` makes only annotated ones |
| the tag is on its release commit | `git fetch --tags origin`, then `git rev-parse 'v<version>^{commit}'` against `git log origin/main --format=%H --grep '^chore: release <version>' -n 1` | the two differ (#1054: v31.1.0 landed on the bump PR's head, not `main`'s merge commit) |
| who made it | `gh api repos/developerz-ai/ultimate/git/refs/tags/v<version> --jq '.object'`, then `gh api repos/developerz-ai/ultimate/git/tags/<sha> --jq '.tagger'` for an annotated one | a tagger other than `github-actions[bot]`, which tags every release (v31.30.0's, read 2026-11-15) |
| was it published | `npm view @ultimat3/core@<version> dist.attestations --json` | attested: `release.yml` ran at that tag |

## Do

| State | Do |
|---|---|
| tag on the wrong commit, version NOT on npm | file an issue `tag squatted: v<version>` with every output above. Stamp the next patch (`bun run scripts/release.ts --bump patch --dry-run --json`, then without `--dry-run`); its section says `v<version> was tagged outside release-tag.yml and is not a release` |
| tag on the wrong commit, version on npm | it shipped. Diff what shipped against the release commit: `git diff v<version> <release-commit-sha> --stat`. Empty diff: nothing to do but the issue. Non-empty: the next patch ships the release commit's tree, and the issue records what the stray version carried |
| a lightweight tag on the right commit | `release-tag.yml` skipped its Release: finish with the command its failed step prints; the tag stays |
| a tag nobody in the org pushed | the token that pushed it is compromised: [`../06-runbooks.md`](../06-runbooks.md#a-credential-leaked), and a security advisory |

Deleting the stray tag is an owner's decision, recorded in the issue — irreversible for anyone who
fetched it, and a deleted-then-recreated tag is exactly what provenance exists to refuse.

## The gap

A tag ruleset restricting `refs/tags/v*` creation to the release workflow would make this page
mostly unnecessary. It is a repository setting, set by an admin; not set `As of 2026-11-15`.
