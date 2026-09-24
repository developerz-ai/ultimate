# History

Why things are the way they are. Decision records moved out of the root `CLAUDE.md` (plan 101,
slice 17 f), which keeps the rules and links here for the reasoning. Nothing here is a current
fact: every current fact is a command in the root `CLAUDE.md`'s fact table.

| Record | What it explains |
|---|---|
| [`publishing-and-provenance.md`](publishing-and-provenance.md) | the first publishes, trusted publishers, 2.0.0's missing provenance, the release gate |
| [`major-sweeps.md`](major-sweeps.md) | how each major was made, and the guard that mechanised half of it |
| [`milestone-11.md`](milestone-11.md) | the deploy proof, and the four gaps closed in 2.0.0 on the way |
| [`tier-decisions.md`](tier-decisions.md) | one record per declared sideways edge, the floor rule, and the measured cost of `core → schema` |
| [`primitive-factories.md`](primitive-factories.md) | why `llm()` and `backfill()` are factories, not new primitives |
| `<package>.md` — [`action`](action.md), [`ai`](ai.md), [`auth`](auth.md), [`cache`](cache.md), [`cli`](cli.md), [`core`](core.md), [`db`](db.md), [`entity`](entity.md), [`http`](http.md), [`jobs`](jobs.md), [`mcp`](mcp.md), [`query`](query.md), [`realtime`](realtime.md), [`render`](render.md), [`scraping`](scraping.md), [`storage`](storage.md), [`testing`](testing.md), [`ui`](ui.md) | the reasoning moved out of each package's `CLAUDE.md` (slice 17 f), verbatim under its original headings; the package file keeps the rules and wins where they differ |
