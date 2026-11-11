// `[Unreleased]` promoted to the version being released — its own `docs/changelog/X.Y.Z.md`, a
// row in the CHANGELOG.md index, a fresh `[Unreleased]` — and the date it is stamped with. The
// changelog half of `scripts/release.ts`, split out so that script stays under the size ceiling.

import { withReleaseTable } from './changelog-index';
import { type Changelog, parseChangelog } from './changelog-sections';
import { type ChangelogFile, versionFile } from './changelog-store';
import type { Finding } from './log';
import { withSecurityException } from './major-window';

export const UNRELEASED_HEADING = '## [Unreleased]';
/** What a fresh `[Unreleased]` says once the release has taken its body. */
export const UNRELEASED_PLACEHOLDER = 'Nothing yet.';

/**
 * The commit subjects go INSIDE the promoted section, under a heading no hand-written section uses.
 * Generating `### Added` / `### Fixed` / `### Changed` was how a release ended up with two
 * `### Fixed` blocks in one section — the generated one below the hand-written one, saying the same
 * thing in worse words.
 */
export const commitBlock = (subjects: readonly string[]): readonly string[] =>
  subjects.length === 0
    ? []
    : ['### Commits', '', ...subjects.map((subject) => `- ${subject}`), ''];

/**
 * PROMOTE, never append. `[Unreleased]` IS the release notes — hand-written as each change lands,
 * migration and all — so a release renames that heading to the version and opens a fresh empty
 * `[Unreleased]` above it.
 *
 * What appending produced is commit 8fe7c56d — `git show 8fe7c56d:CHANGELOG.md`, this script's own
 * output for `release: 6.0.0`: seven `BREAKING —` entries still under `## [Unreleased]`, a
 * `## 6.0.0` holding six merge subjects and nothing else, and two `## 5.0.1` plus two `## 5.0.0`
 * headings left by the two runs before it — an auto section above a hand-written one, same version.
 * `wiki/Upgrading.md` pointed at the `6.0.0` section throughout.
 *
 * `git show v6.0.0:CHANGELOG.md` does NOT show this: the tag points at 93443aeb, a human repairing
 * 8fe7c56d by hand. Read the tag and the bug is invisible; read 8fe7c56d and it is the whole diff.
 *
 * Promotion cannot produce either shape ON ITS OWN: one heading is renamed rather than duplicated.
 * It can still be ASKED for a version the page already holds — `--version 6.0.0` re-run after a
 * botched release, or run against 93443aeb, where a human had already written that section by hand
 * — and renaming `[Unreleased]` to a heading that exists puts a second one directly above it. That
 * is refused, not written: `checkChangelog` would red on the result, and it would red after 47
 * manifests, the chart and CHANGELOG.md had already moved.
 *
 * Since 31.3.0 the promoted section is its own file, `docs/changelog/X.Y.Z.md`, and the index gains
 * its row in the same write; `--security` records its advisory in that file. The `changelog` it
 * returns is the after-state every later step reads (the Stability page's next-window line).
 */
export function promoteUnreleased(input: {
  readonly index: string;
  readonly changelog: Changelog;
  readonly version: string;
  readonly date: string;
  readonly subjects: readonly string[];
  readonly security?: string | undefined;
}):
  | { readonly index: string; readonly file: ChangelogFile; readonly changelog: Changelog }
  | { readonly findings: readonly Finding[] } {
  // The loaded sections, not a regex of this file's own: what counts as "the 6.0.0 section" is the
  // gate's question, and two answers to it is how a release passes here and reds there.
  const held = input.changelog.find((section) => section.version === input.version);
  if (held !== undefined) {
    return {
      findings: [
        {
          code: 'X_DOC_CHANGELOG_SECTION_INVALID',
          cause: `${held.file}:${held.line} already holds \`## ${held.heading}\`, so promoting [Unreleased] to ${input.version} would write a second section for one version`,
          fix: `bun run scripts/release.ts --bump patch --dry-run --json   # a version docs/changelog/ does not hold yet; or delete ${held.file} if that release never shipped`,
          at: `${held.file}:${held.line}`,
        },
      ],
    };
  }
  const lines = input.index.split('\n');
  const at = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (at === -1) {
    return {
      findings: [
        {
          code: 'X_RELEASE_UNRELEASED_MISSING',
          cause: 'CHANGELOG.md has no `## [Unreleased]` heading, so there is nothing to promote',
          fix: 'add `## [Unreleased]` under the preamble of CHANGELOG.md, above the newest version',
          at: 'CHANGELOG.md',
        },
      ],
    };
  }
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(at + 1, end)
    .filter((line) => line.trim() !== UNRELEASED_PLACEHOLDER)
    .join('\n')
    .trim();
  const commits = commitBlock(input.subjects);
  if (body.length === 0 && commits.length === 0) {
    return {
      findings: [
        {
          code: 'X_DOC_CHANGELOG_SECTION_INVALID',
          cause: `[Unreleased] is empty and no commit landed since the previous tag, so ${input.version} would ship a section that says nothing`,
          fix: 'write the release notes under `## [Unreleased]` in CHANGELOG.md, then run this again',
          at: 'CHANGELOG.md',
        },
      ],
    };
  }
  const section = [`## ${input.version} - ${input.date}`, ''];
  if (body.length > 0) section.push(...body.split('\n'), '');
  section.push(...commits);
  const path = versionFile(input.version);
  const text = `${withSecurityException(section.join('\n'), input.version, input.security).trimEnd()}\n`;
  const reset = [
    ...lines.slice(0, at),
    UNRELEASED_HEADING,
    '',
    UNRELEASED_PLACEHOLDER,
    '',
    ...lines.slice(end),
  ].join('\n');
  // The after-state: the fresh [Unreleased], the new release, then every release before it.
  const changelog = [
    ...parseChangelog(reset).filter((one) => !one.released),
    ...parseChangelog(text, path),
    ...input.changelog.filter((one) => one.released),
  ];
  return { index: withReleaseTable(reset, changelog), file: { path, text }, changelog };
}

/**
 * `en-CA` is ISO-8601 by locale, and the zone is stated because nothing here may format a date
 * without one. UTC, so a release cut at 23:00 in one timezone is not dated a day apart from the tag.
 */
export const releaseDate = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
