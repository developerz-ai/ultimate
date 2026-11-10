# Governance

> **Draft, unsigned** `As of 2026-11-03`. Every statement below describes how the project runs
> today. It takes effect when the owner signs it at the foot of this page; until then it is a
> description, not a commitment.

Ultimate is owned by one organisation and maintained day to day by an AI. This page says who
decides what, what the AI may and may not do, how a release reaches npm, and what happens to the
project if either of them stops.

## Who decides

| Who | Decides |
|---|---|
| **the owner**: [developerz.ai](https://developerz.ai), the `developerz-ai` GitHub organisation and its owners | the design axioms (`CLAUDE.md`), the eight primitives, the tier table, what the project is for; repository and npm settings; this page |
| **the maintainer bot**: the developerz.ai platform, under the policy committed in [`.dz/maintainer/maintainer.yml`](.dz/maintainer/maintainer.yml) | triage, review, fixes, merges, and whether a week's merges are worth a release |
| **CI**: `x verify` on every pull request ([`ci.yml`](.github/workflows/ci.yml)) | whether a change is shippable. Merging only on green is the convention, not a lock: `main`'s `main-protection` ruleset refuses deletion and force-push and requires no status check, `As of 2026-11-10` (`gh api repos/developerz-ai/ultimate/rules/branches/main --jq '[.[].type]'`); requiring `verify` is an owner setting |

The owner comes back with new ideas once or twice a year. In between, the bot is the maintainer
a contributor meets.

## What the bot may do

- Triage every issue, from anyone: ask for a reproduction, label, close a duplicate or an
  unanswered request after the period its policy states.
- Review every pull request, from anyone, and drive it to green and merge it.
- Merge Dependabot updates once CI is green.
- Make a breaking change: a major is its call inside the major window ([Stability](wiki/Stability.md)), weighed against the migration it costs every app.
- Open the version bump when it judges a release is due. Merging that bump is the release.

## What the bot may not do

- Decline a request for any reason but the `non_goals` list in its policy, each one a design
  axiom quoted. That list is the only out-of-scope answer it can give.
- Merge an outside contributor's change to CI, release or publish automation (`.github/`,
  `scripts/release*`, `PUBLISHING.md`): members maintain the pipeline that publishes.
- Decide a security report, a licence question or a contributor agreement: its policy lists
  those as asks for the owner, not calls of its own.
- Publish from anywhere but the release workflow below: the bump it opens is merged on green CI
  like any other pull request, and the workflow does the rest.

## How a release reaches npm

One path, and no long-lived npm token is part of it:

1. A `chore: release <version>` pull request merges on green CI.
2. `release-tag.yml` tags the commit (annotated), creates the GitHub Release and dispatches
   `release.yml`.
3. `release.yml` runs its `check` job, then publishes every package through **npm trusted
   publishing (OIDC)** from the `npm-publish` environment, with a provenance attestation.

Check any release yourself: `npm view @ultimat3/core@<version> dist.attestations _npmUser`. The
whole procedure: [`PUBLISHING.md`](PUBLISHING.md).

## Continuity

- **The licence stays MIT.** Every published version stays on npm under it, and anyone may fork.
- **If the bot stops**, nothing published changes: the packages, the tags and the source stay
  where they are, and the gate still runs on any clone (`bun run verify`). Issues and pull
  requests wait for the owner.
- **If the owner stops**, the owner names a successor in writing, on this page, by pull request.
  Until one is named, the fork is the continuity: the code is MIT and the gate travels with it.

Successor: _not yet named._

## Conduct and security

- Behaviour in every project space: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- A vulnerability, privately: [`SECURITY.md`](SECURITY.md).

## Changing this page

By pull request, like any other file. A change to who decides, or to the continuity section, is
the owner's to merge.

## Signature

_Unsigned draft._ Signed for the owner: _name, role, date_.
