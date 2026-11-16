# The registry lags

**npm serves less than the tree says: wait on the audit, never publish by hand.** npm lists a
version minutes before it serves the tarball (v29.4.0's scaffold 404'd on a listed version), and a
package added after a release is unpublished until it is bootstrapped.

## Notice

| Signal | Command |
|---|---|
| every publishable package at the stamped version, attested, `latest` on it, tarball served | `bun run scripts/registry-audit.ts --tarballs --json` |
| the daily alarm | `gh issue list --state open --label registry-drift --json number,title,updatedAt,url` — opened by `.github/workflows/registry-audit.yml` |
| one package | `npm view @ultimat3/<pkg> version dist-tags --json` |

## Do, by the finding's `kind`

| `kind` | Means | Do |
|---|---|---|
| `behind` within an hour of a `release.yml` run | npm has not caught up | nothing; the `npm-scaffold` job already polls it (40 × 30 s). Re-read the audit after the run ends |
| `behind` after the run concluded `success` | a publish the workflow believes landed | read the run: `gh run list --workflow release.yml --limit 1 --json conclusion,headSha,url`. File an issue with the audit's JSON and the run URL |
| `behind` after the run failed | a partial publish: tiers before the failure are out, the rest are not | fix the cause; the next patch publishes every package again in lockstep. Never finish the tiers by hand |
| `absent` | a package never published — it needs its one bootstrap | `PUBLISHING.md` § Human steps outside this file, step 1: a person with npm rights, never the bot |
| `unattested` | published without provenance — not through `release.yml` | file it as a security issue: something published outside the one path |
| `unreachable` | the registry did not answer | re-read; no verdict, never a finding |

`latest` on the wrong version (`X_REGISTRY_LATEST_DRIFT`) is a split set: file it with the audit's
JSON. Moving a dist-tag is a person's act on npm, never this loop's.

## Never

- `npm publish` from a laptop, the bot, or any workflow but `release.yml`.
- `npm unpublish` — 72-hour window, and it breaks every lockfile that resolved the version.
