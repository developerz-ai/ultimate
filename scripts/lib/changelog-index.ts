// CHANGELOG.md as an INDEX: `[Unreleased]`, then one `Version | Date | Summary` row per release,
// derived from `docs/changelog/X.Y.Z.md` and never hand-kept. What the table says, how a release
// section left in the index moves out to its own file byte for byte, and the findings when either drifts.

import { CHANGELOG_PATH } from './changelog-format';
import { openingHighlights } from './changelog-highlights';
import { type Changelog, type ChangelogSection, parseChangelog } from './changelog-sections';
import { assembleChangelog, type ChangelogFile, fileVersion, versionFile } from './changelog-store';
import type { Finding } from './log';

export const RELEASES_HEADING = '## Releases';
const OLDER_HEADING = '## Older releases';
const SEMVER = /^\d+\.\d+\.\d+$/;
const DATED = / - (\d{4}-\d{2}-\d{2})$/;
const WRITE = 'bun run scripts/changelog-index.ts --write --json';

const cell = (text: string): string => text.replaceAll('|', '\\|').trim();

/**
 * The row's summary, quoted and never written: the first `### Highlights` bullet when the section
 * opens with them, else its `###` kinds in page order (`Fixed · Added`), the commit list left out.
 */
export function summaryOf(section: ChangelogSection): string {
  const first = openingHighlights(section.body)?.[0];
  if (first !== undefined) return cell(first.slice(2));
  const kinds = section.lines
    .filter((line) => line.startsWith('### '))
    .map((line) => line.slice(4).trim())
    .filter((kind) => kind !== 'Commits');
  const unique = [...new Set(kinds)];
  return unique.length === 0 ? '—' : cell(unique.join(' · '));
}

/** The table, one row per released section, newest first. */
export function releaseTable(changelog: Changelog): readonly string[] {
  const rows = changelog
    .filter((section) => section.released && SEMVER.test(section.version))
    .map(
      (section) =>
        `| [${section.version}](${versionFile(section.version)}) | ${DATED.exec(section.heading)?.[1] ?? '—'} | ${summaryOf(section)} |`,
    );
  return ['| Version | Date | Summary |', '|---|---|---|', ...rows];
}

/** The index with its `## Releases` block rewritten from `changelog`; added above Older releases. */
export function withReleaseTable(index: string, changelog: Changelog): string {
  const lines = index.split('\n');
  const block = [RELEASES_HEADING, '', ...releaseTable(changelog), ''];
  const at = lines.indexOf(RELEASES_HEADING);
  if (at !== -1) {
    const next = lines.findIndex((line, i) => i > at && line.startsWith('## '));
    lines.splice(at, (next === -1 ? lines.length : next) - at, ...block);
    return lines.join('\n');
  }
  const older = lines.indexOf(OLDER_HEADING);
  if (older !== -1) lines.splice(older, 0, ...block);
  else lines.push('', ...block);
  return lines.join('\n');
}

/**
 * Every `## X.Y.Z` section still in the index, moved to `docs/changelog/X.Y.Z.md` verbatim: the
 * heading and every line to the next `## `, trailing blank lines dropped, so the files joined by
 * `\n` are the original sections byte for byte. A version that already has a file is refused.
 */
export function moveReleasedSections(
  index: string,
  existing: readonly ChangelogFile[],
): {
  readonly index: string;
  readonly moved: readonly ChangelogFile[];
  readonly findings: readonly Finding[];
} {
  const lines = index.split('\n');
  const kept: string[] = [];
  const moved: ChangelogFile[] = [];
  const findings: Finding[] = [];
  const taken = new Set(existing.map((file) => file.path));
  for (let at = 0; at < lines.length; ) {
    const line = lines[at] ?? '';
    const version = line.startsWith('## ') ? parseChangelog(line)[0]?.version : undefined;
    if (version === undefined || !SEMVER.test(version)) {
      kept.push(line);
      at += 1;
      continue;
    }
    let end = lines.findIndex((one, i) => i > at && one.startsWith('## '));
    if (end === -1) end = lines.length;
    const chunk = lines.slice(at, end);
    while (chunk.length > 1 && (chunk.at(-1) ?? '').trim() === '') chunk.pop();
    const path = versionFile(version);
    if (taken.has(path)) {
      findings.push({
        code: 'X_DOC_CHANGELOG_SECTION_INVALID',
        cause: `${CHANGELOG_PATH}:${at + 1} holds \`${line}\` and ${path} already exists, so moving it would overwrite that release's notes`,
        fix: `grep -n '^## ' CHANGELOG.md   # then merge the section the cause names into ${path} or delete it, and rerun: ${WRITE}`,
        at: `${CHANGELOG_PATH}:${at + 1}`,
      });
      kept.push(...lines.slice(at, end));
    } else {
      taken.add(path);
      moved.push({ path, text: `${chunk.join('\n')}\n` });
    }
    at = end;
  }
  return { index: kept.join('\n'), moved, findings };
}

/** One version file's own shape: exactly one `## ` section, the release its name says. */
function fileFindings(file: ChangelogFile): readonly Finding[] {
  const sections = parseChangelog(file.text, file.path);
  const named = fileVersion(file.path)?.join('.');
  if (named !== undefined && sections.length === 1 && sections[0]?.version === named) return [];
  const heading = sections[0]?.heading;
  return [
    {
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause:
        named === undefined
          ? `${file.path} is not named X.Y.Z.md, so no release owns it`
          : `${file.path} holds ${sections.length} \`## \` section(s)${heading === undefined ? '' : `, the first \`## ${heading}\``}, where it must hold exactly \`## ${named} - YYYY-MM-DD\``,
      fix: `ls docs/changelog/   # then give ${file.path} one \`## X.Y.Z - YYYY-MM-DD\` heading on line 1, X.Y.Z its file name, and rerun: ${WRITE}`,
      at: `${file.path}:1`,
    },
  ];
}

/**
 * The index and the files agree: no release section left in the index, every file one release, at
 * least one release (zero is a reader looking in the wrong place, never a quiet changelog), and the
 * table exactly what `releaseTable` derives.
 */
export function indexFindings(index: string, files: readonly ChangelogFile[]): readonly Finding[] {
  const findings: Finding[] = files.flatMap(fileFindings);
  for (const section of parseChangelog(index)) {
    if (!SEMVER.test(section.version)) continue;
    findings.push({
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause: `${CHANGELOG_PATH}:${section.line} holds \`## ${section.heading}\`, and CHANGELOG.md is the index: a release's notes live in ${versionFile(section.version)}`,
      fix: WRITE,
      at: `${CHANGELOG_PATH}:${section.line}`,
    });
  }
  const changelog = assembleChangelog(index, files);
  if (!changelog.some((section) => section.released)) {
    findings.push({
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause:
        'docs/changelog/ holds no release section, so every changelog rule would read nothing and pass',
      fix: 'ls docs/changelog/   # run from the repository root; one X.Y.Z.md per release must be there',
      at: 'docs/changelog/',
    });
    return findings;
  }
  if (withReleaseTable(index, changelog) !== index) {
    findings.push({
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause: `${CHANGELOG_PATH}'s \`${RELEASES_HEADING}\` table is not the one derived from docs/changelog/ — a row missing, stale or hand-edited`,
      fix: WRITE,
      at: CHANGELOG_PATH,
    });
  }
  return findings;
}
