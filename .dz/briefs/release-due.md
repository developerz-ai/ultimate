# Brief: is a release due?

Weekday checkup, fired by `schedules: release-due` in `.dz/maintainer/maintainer.yml`. Ultimate
releases like a maintained project: when merged work that ships has waited for a release, it gets
one. The decision is a command, never a judgement made here.

## Run

```bash
bun run scripts/release-due.ts --json
```

| `data.due` | `data.reason` | What to file |
|---|---|---|
| `false` | `nothing_ships` | nothing |
| `false` | `settling` | nothing — an org member may still release their own work; next checkup decides |
| `false` | `major_needs_a_maintainer` | nothing, unless no open issue already says a major is pending: then one issue listing `data.breaking`, for a maintainer |
| `true` | — | one ask: **Release `<data.next>`**, listing `data.shipping` |

## The ask, when due

Title `Release <next>`. Body, verbatim steps for the box that takes it:

1. `bun run scripts/release-due.ts --json` again on fresh `main` — still due, same `next`, or stop.
2. A Dependabot-only window adds nothing under `## [Unreleased]` in `CHANGELOG.md`: add a
   `### Changed` line naming each bumped runtime dependency and its new range first.
3. Run the `data.command` it printed (`bun run scripts/release.ts --version <next>`), then
   `bun run verify`.
4. One PR, `chore: release <next>`, nothing else in the diff. It merges on green like any PR.
5. Merging it is the release: `.github/workflows/release-tag.yml` tags `v<next>` (annotated),
   publishes the GitHub Release and dispatches `release.yml`. Never tag, never `gh release create`,
   never `npm publish` by hand — `PUBLISHING.md`. The canonical close is the workflow's own
   `close the release ask` step — by the job that did the tag, on the exact title
   `Release <next>`. The PR body carrying `Fixes #<ask>` is a backstop, not the path:
   `scripts/release.ts` prints the ask link when one is open.

Never file a second ask while one titled exactly `Release <next>` is open — byte-for-byte:
`release <v> did not publish`, `Release <v> (#N)`, `Release <other>` are not twins (the version
is the whole title, no trailing prose). The box fetches candidates with
`gh issue list --state open --search "Release <next> in:title"`, where `<next>` is `data.next` from
the run above — substitute the version before running it — then post-filters them by exact title
match.
