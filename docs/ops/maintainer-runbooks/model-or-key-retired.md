# The model or key the platform runs on is retired

**This repository names no model and holds no model key: the fix is on the platform, and the
repository's part is to notice and to prove the loop is back.** `.dz/maintainer/maintainer.yml`
declares policy only — triage, PR, review, release, schedules — and no field selects a model
(`grep -n -i 'model' .dz/maintainer/maintainer.yml` matches nothing, read 2026-11-15). The model, its
provider key and their rotation are the maintainer platform's configuration.

## Notice

A retired model or a revoked key does not fail loudly here. The bot simply stops acting, or acts
and fails before it writes. The signals are the same as [`maintainer-down.md`](./maintainer-down.md),
plus one that separates the two:

| Signal | Command | Points at the model or key when |
|---|---|---|
| the bot still comments | `gh api 'repos/developerz-ai/ultimate/issues/comments?sort=created&direction=desc&per_page=100' --jq '[.[] \| select(.user.login == "developerz-ai[bot]")][0].created_at'` | it comments, but each comment is an error notice rather than a review or a triage |
| the bot still reviews | `bun run x -- pr review --pr <n> --json` on the newest PR | no review from it after the PR's last push, past the time its reviews usually take |
| the bot still opens PRs | `gh search prs --repo developerz-ai/ultimate --author app/developerz-ai --sort created --limit 1 --json number,createdAt` | a release-due week passed with a release owed and no bump PR from it |

## Do

| # | Step |
|---|---|
| 1 | Confirm it is the model or key, not the whole platform: the bot's comments are error notices naming the provider, an unknown model, or an auth failure. No comments at all is [`maintainer-down.md`](./maintainer-down.md) |
| 2 | File one issue, `maintainer: model or key refused`, quoting the newest error notice and its URL. Never paste a key, a token or a provider account id into it |
| 3 | The platform's owner rotates the key or moves the model in the platform's configuration — outside this repository; nothing here changes |
| 4 | Prove the loop is back: the bot reviews the next PR and comments on the next issue. Close the issue with those two URLs. A brief's asks and run summaries live on the platform, not in this repository — the platform's owner confirms the next scheduled run there |

## Never

- Add a model name or a key to `.dz/maintainer/maintainer.yml` or a brief to "pin" it. A model name
  in the repository is a second answer to a question the platform owns, and a key is a secret.
- Merge PRs unreviewed while the bot is out. `require_review: true` holds; a person reviews instead.
