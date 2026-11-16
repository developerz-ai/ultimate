# Maintainer runbooks

**One page per way the repository's own maintenance loop breaks.** The briefs in `.dz/briefs/`
cite these; a person reads the same page. Each one: how it is noticed (a command), what to do, what
never to do. `As of 2026-11`.

This is the framework repository's loop — CI, release, registry, review, the maintainer bot. A
running app's incidents are [`../06-runbooks.md`](../06-runbooks.md).

| Runbook | Noticed by | Cited by |
|---|---|---|
| [`main-red.md`](./main-red.md) | a failed `ci.yml` run on a push to `main`; health row `main-green` | `.dz/briefs/main-red.md` |
| [`release-commit-red.md`](./release-commit-red.md) | a version stamped on `main` with no tag; health row `stamped-version-tagged` | `.dz/briefs/main-red.md`, `.dz/briefs/adopter-canary.md` |
| [`registry-lags.md`](./registry-lags.md) | `bun run scripts/registry-audit.ts --json` not `ok`; the `registry-drift` issue | `.dz/briefs/adopter-canary.md` |
| [`tag-squatted.md`](./tag-squatted.md) | a `v*` tag that is lightweight, or off its release commit | `.dz/briefs/adopter-canary.md` |
| [`review-bot-disagrees.md`](./review-bot-disagrees.md) | an open review thread on a PR whose gate is green | `.dz/briefs/audit.md`, `.dz/briefs/main-red.md` |
| [`model-or-key-retired.md`](./model-or-key-retired.md) | the maintainer bot's runs stop leaving evidence | `.dz/briefs/evidence.md` |
| [`maintainer-down.md`](./maintainer-down.md) | no bot comment, review or issue for N days | no brief: the bot cannot report its own absence, so a person reads it |

## The rules every page keeps

| Rule | Why |
|---|---|
| never rerun a red test step to green | a rerun that passes hides a flake; the flake hunt (`.github/workflows/flake-hunt.yml`) and a fix are the answer. The one rerun: a run that died of its runner, no step failed ([`release-commit-red.md`](./release-commit-red.md)) |
| never move, delete or re-point a pushed tag | a tag is what npm provenance attests; the fix ships as the next patch (`PUBLISHING.md`) |
| never `npm publish` or `npm unpublish` by hand | `.github/workflows/release.yml` is the one publish path (axiom 1) |
| every finding is an issue or a PR | a run that found nothing says so in its summary: `nothing found: <what was read>` |
