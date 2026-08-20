# Cutting a major

The maintainer side of a breaking release: which file records what, when the record is written, and
which half of it a gate catches. The reader side is [`../../wiki/Upgrading.md`](../../wiki/Upgrading.md);
the publish mechanics are [`../../PUBLISHING.md`](../../PUBLISHING.md). `As of 2026-08`.

## The rule

**Every major gets one section in `wiki/Upgrading.md`, and it is created when the first breaking
change lands — not at release time.** The author of the change is the only person who knows what the
edit is; three weeks later it is reconstructed from a diff, and that is how a migration line ends up
describing the change instead of naming the edit.

| Question | Answer |
|---|---|
| Where | `wiki/Upgrading.md`, one `## <previous major>.x → <new major>, entry by entry` section |
| Order | newest first, directly under the summary table |
| Created | in the PR that lands the first `BREAKING —` entry of that major |
| Marked | `— **unreleased**` in the heading until the tag exists; deleting those two words is a release-commit edit |
| Retired | never, and an old heading is never reworded — the heading *is* the anchor, and issues and other pages link to it |

`## 4.1.0 → 5.0.0` and `## 3.0.0 → 4.0.0` predate the `<previous major>.x` spelling and keep their
headings for that reason. The summary table's `From → to` column is the place to be consistent.

## Audience split

| Reader | Asking | Reads |
|---|---|---|
| app author | "I am on 5.0.1 and want 6.0.0 — what do I edit?" | `wiki/Upgrading.md` |
| maintainer | "we are cutting a major — what do I write, and where?" | this page |
| release runner | "the tag is cut — how does it reach npm?" | `PUBLISHING.md` |

`wiki/` is the only public documentation surface and carries no process meta; it is synced to the
GitHub wiki on merge, and this page is not. That split is the whole reason the convention lives here
and the walkthrough lives there.

## `CHANGELOG.md` is the record; the wiki section is the walkthrough

Link across, never duplicate. A table copied into both disagrees with itself by the next patch.

| Belongs in `CHANGELOG.md` | Belongs in `wiki/Upgrading.md` |
|---|---|
| the full enumeration — 6.0.0's 43 refused timezone names, each with its replacement | which classes swap mechanically and which have no replacement at all |
| why the change was necessary, at length, with the measurement behind it | the one diff a reader pastes |
| the issue number | where in an app the affected spelling hides, and what finds it |

6.0.0's 43-name table is the standing temptation: it lives under `[Unreleased]` in `CHANGELOG.md`
and the wiki section links to it by anchor. Copying it would give a reader two lists to reconcile
the first time one gains a row.

## The section's shape

Fixed, so a later entry is **appended** rather than a rewrite. `## 5.x → 6.0.0` and
`## 4.1.0 → 5.0.0` both instantiate it:

| Order | Subsection | Holds |
|---|---|---|
| 1 | the opening line | the entry count, and the honest size of the migration — "the whole migration is deleting one line, and only if you wrote it" |
| 2 | `### Start here — the one edit` | a `diff` fence. A reader who does nothing else does this |
| 3 | one `###` per remaining breaking entry | the surface, the edit, and what it silently did before |
| 4 | `### Where …` | the `grep` that lists every affected site, and whether a build error finds them for you |
| 5 | `### Fixed, and neither costs an edit` | a table of the non-breaking fixes shipping in the same release |

A new breaking entry lands in 3 and a new fix lands as a row in 5; neither touches anything above
it. That is the only reason the shape is fixed.

## Every entry names the edit, because there is no codemod

`x upgrade` exits `X_NOT_IMPLEMENTED` (`packages/cli/src/cmd-planned.ts`, `PLANNED_COMMANDS`) and no
release has ever shipped a codemod. An entry that describes a change without naming the edit is not
finished — the same rule a `fix:` line already lives under (axiom 4), one file set further out.

| Not an entry | An entry |
|---|---|
| "`jobs.driver` was removed" | "delete the `driver:` key from `jobs` in `app.config.ts`" |
| "abbreviations are refused" | "`zone: 'CET'` → `zone: 'Europe/Paris'` — only the author knows which city" |
| "check your timezone config" | the `grep` that lists every site, and the note that nothing fails at compile time |

## What moves in the same commit as a new section

The counts are precisely what drifted. `wiki/Upgrading.md` shipped `There are three majors to
cross` over a table ending at `3.0.0 → 4.0.0` and a `1.x → 4.0.0 | 68` total, in a file whose own
`## 4.1.0 → 5.0.0` section sat twenty lines below it.

| Edit | Why it is in the same commit |
|---|---|
| the header sentence — "four majors have shipped; a fifth is in flight" | it is the first thing on the page and it counts the sections |
| a summary-table row for the new major | the table is the index; a section not in it is a section nobody reaches |
| the `1.x → <latest>` total | it is a sum, and a sum with a new addend is wrong until it is redone |

Re-derive the counts, never increment them:

```sh
grep -cE '^(- \*\*|### )BREAKING —' CHANGELOG.md
```

An **entry** is a line marked `BREAKING —`, which is what makes the number reproducible. It is not
a count of changed *surfaces*: 5.0.0's two entries touch six, and its `CHANGELOG.md` header says
"four breaking changes", which is neither. Say which one a number counts, or it will be read as the
other.

## What a major covers

`wiki/Upgrading.md`'s `## What semver covers` is the definition — five surfaces, and it is the
public promise. Do not restate it here, in a changelog entry, or in a package README: a second copy
is a second answer. A change is a major when it changes one of those five in a way that stops
compiling, or stops meaning what it meant.

## Lockstep

One version, one commit, one tag, 30 tarballs. [`../../PUBLISHING.md`](../../PUBLISHING.md) owns
every step of it and this page restates none of them. The one thing to check before starting a
release run: the section for this major exists and its heading still says `unreleased`, because
releasing it is then a two-word deletion rather than a page to write under time pressure.

## Enforced, and not

| Rule | Enforced by | `x verify` step |
|---|---|---|
| every `` `x …` `` on a `wiki/` or `docs/` page resolves against the real command registry | `scripts/doc-commands.ts` | `manifest` |
| every `wiki/` table renders as a table | `scripts/wiki-tables.ts` | `manifest` |
| exactly one page stamps a version, and it is the shipped one | `scripts/version-stamps.ts` | `manifest` |
| all 30 workspaces at the tag's version before the first publish | `scripts/release.ts --check <version>` | the release workflow, not the gate |
| **a major has a `wiki/Upgrading.md` section** | nothing | — |
| **the summary table's counts match `CHANGELOG.md`** | nothing | — |
| **every `BREAKING —` entry names an edit** | nothing | — |

The last three are conventions, and per axiom 3 a convention that is not a build error does not
exist. The cheapest one is also the one that has already failed: an `upgradeSectionFindings` on the
`manifest` step, counting `BREAKING —` entries per released major in `CHANGELOG.md` and comparing
each against its row in the summary table, with a finding that names the row and the number it
should hold. `scripts/version-stamps.ts` is the model — same file set, same step, same shape of
claim.
