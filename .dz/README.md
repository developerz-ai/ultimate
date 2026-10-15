# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: who the bot acts for, what it merges, how it releases — [reference](https://developerz.ai/docs/maintainer-yml) |
| `briefs/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `release-due.md` (is a release owed), `health.md` (the failures nothing announces) |

Ultimate is AI-maintained. Outside users' issues are triaged and their bugs fixed by the bot; their
pull requests, the bot's own and Dependabot's are driven to green and merged by it. An issue or
pull request by anyone with write access (org members, collaborators) is left to its author: a pull
request is still reviewed, and an @-mention of the bot is answered. An outside change to CI, release
or publish automation is declined. Every pull request is reviewed.
Releases follow `PUBLISHING.md`, and there is one path for the bot and for people alike.
