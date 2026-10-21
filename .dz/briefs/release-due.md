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
4. One PR, `chore: release <next>`, nothing else in it. It merges on green like any PR.
5. Merging it is the release: `.github/workflows/release-tag.yml` tags `v<next>` (annotated),
   publishes the GitHub Release and dispatches `release.yml`. Never tag, never `gh release create`,
   never `npm publish` by hand — `PUBLISHING.md`.

Never file a second ask while one titled `Release <next>` is open. The box reads that with
`gh issue list --state open --search "Release <next> in:title"`, where `<next>` is `data.next` from
the run above — substitute the version before running it.
