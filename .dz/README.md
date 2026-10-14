# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: who the bot acts for, what it merges, how it releases — [reference](https://developerz.ai/docs/maintainer-yml) |
| `briefs/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `release-due.md` (is a release owed), `health.md` (the failures nothing announces) |

Ultimate is AI-maintained. Outside users' issues are triaged and their bugs fixed by the bot; their
pull requests are reviewed and, until the platform's member scope ships (`auto_merge_scope` is
`own_and_dependency_bots` for now), merged by a member. The bot merges its own and Dependabot's.
Org members' work is reviewed and otherwise left to them. Every pull request is reviewed.
Releases follow `PUBLISHING.md`, and there is one path for the bot and for people alike.
