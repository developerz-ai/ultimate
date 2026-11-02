# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: who the bot acts for, what it merges, how it releases — [reference](https://developerz.ai/docs/maintainer-yml) |
| `briefs/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `release-due.md` (weekly: is a release needed), `security-release.md` (the one off-cycle release: a confirmed security fix), `health.md` (the failures nothing announces), `improve.md` (monthly: at most three small, evidenced improvements) |

What the bot does for whom is stated once, in the README's
[AI-maintained](../README.md#ai-maintained) section, and decided here by `maintainer/maintainer.yml`.
