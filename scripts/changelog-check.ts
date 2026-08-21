#!/usr/bin/env bun
// Enforce, as a gate rule, that CHANGELOG.md's sections are well-formed and that every migration
// count in wiki/Upgrading.md is read out of that major's OWN section.
//
// The gap this closes is at commit 8fe7c56d — `git show 8fe7c56d:CHANGELOG.md`. That is
// `release: 6.0.0`, the release script's OWN output: seven `BREAKING —` entries still under
// `## [Unreleased]`, a `## 6.0.0` holding six merge subjects and nothing else, and two `## 5.0.1`
// plus two `## 5.0.0` headings carried over from the two runs before it — while wiki/Upgrading.md
// already told the reader to read the `6.0.0` section.
//
// Read the TAG and none of that is visible: `git show v6.0.0:CHANGELOG.md` has the migration inside
// `## 6.0.0` and no duplicate `## ` heading, because v6.0.0 points at 93443aeb — a human repairing
// 8fe7c56d by hand. The tag is evidence of the repair, never of the defect, and the repair is what
// this file replaces. Two `### Fixed` blocks inside 6.0.0 (`v6.0.0:CHANGELOG.md:129` and `:139`)
// are what the hand pass missed.
//
// The count that should have caught it WAS derived — from the whole file — and a migration filed
// under the wrong heading is invisible to a whole-file count, because a misplaced entry only makes
// the number smaller. Per-section is the entire point of this file.
//
//   bun run scripts/changelog-check.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';

const SCRIPT = 'changelog-check';
export const CHANGELOG_PATH = 'CHANGELOG.md';
export const UPGRADING_PATH = 'wiki/Upgrading.md';

/**
 * One line, one breaking entry — the identical regex wiki/Upgrading.md hands the reader in a fenced
 * `grep -cE`. Anchored at column 0 deliberately: an INDENTED `- **BREAKING —` is a sub-bullet of
 * the entry above it and not an entry of its own, which is how the `Bun.Image` entry carries three.
 */
export const BREAKING_ENTRY = /^(?:- \*\*|### )BREAKING —/;

/** `## [Unreleased]` holds work that has no version yet, so the released-section rules skip it. */
const UNRELEASED = 'unreleased';

/** Semver applies from 1.0.0, and 1.0.0 itself has nothing to migrate FROM — the table starts at 2. */
const FIRST_MIGRATABLE_MAJOR = 2;

export interface ChangelogSection {
  /** Heading text after `## `, verbatim. */
  readonly heading: string;
  /** `unreleased`, a bare semver, or the lowercased heading when it is neither. */
  readonly version: string;
  readonly released: boolean;
  /** 1-based, so `CHANGELOG.md:13` opens it in an editor. */
  readonly line: number;
  readonly breaking: number;
  /** Whether any non-blank line sits under the heading. */
  readonly filled: boolean;
}

const versionOf = (heading: string): string => {
  if (/^\[unreleased\]/i.test(heading)) return UNRELEASED;
  return /^\[?(\d+\.\d+\.\d+)\]?/.exec(heading)?.[1] ?? heading.toLowerCase();
};

export function parseChangelog(text: string): readonly ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const lines = text.split('\n');
  let current: { heading: string; line: number; breaking: number; filled: boolean } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    sections.push({
      heading: current.heading,
      version: versionOf(current.heading),
      released: versionOf(current.heading) !== UNRELEASED,
      line: current.line,
      breaking: current.breaking,
      filled: current.filled,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('## ')) {
      flush();
      current = { heading: line.slice(3).trim(), line: index + 1, breaking: 0, filled: false };
      continue;
    }
    if (current === undefined) continue;
    if (line.trim().length > 0) current.filled = true;
    if (BREAKING_ENTRY.test(line)) current.breaking += 1;
  }
  flush();
  return sections;
}

export interface MigrationRow {
  readonly line: number;
  readonly claimed: number;
  /** The single section this row sends the reader to, or `undefined` on the aggregate row. */
  readonly target: string | undefined;
  readonly aggregate: boolean;
  readonly quote: string;
}

/**
 * The summary table's rows, told apart by their READ cell rather than by position: a row saying
 * "the `4.0.0` section" is about one major, and the row saying "all five sections" is the total.
 * Reading position instead would break the day a major is inserted, which is every major.
 */
export function parseMigrationTable(text: string): readonly MigrationRow[] {
  const rows: MigrationRow[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const cells = line.split('|');
    if (cells.length !== 5 || !line.trimStart().startsWith('|')) continue;
    const claimed = /\*\*(\d+)\*\*/.exec(cells[2] ?? '')?.[1];
    if (claimed === undefined) continue;
    const read = cells[3] ?? '';
    const target = /the `(\d+\.\d+\.\d+)` section/.exec(read)?.[1];
    const aggregate = /all\s+\w+\s+sections/.test(read);
    if (target === undefined && !aggregate) continue;
    rows.push({
      line: index + 1,
      claimed: Number.parseInt(claimed, 10),
      target,
      aggregate,
      quote: line.trim(),
    });
  }
  return rows;
}

/** The `# <n>` the fenced `grep -cE` in wiki/Upgrading.md promises the reader they will see. */
export function parseDerivedTotal(text: string): { line: number; claimed: number } | undefined {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /grep -cE.*BREAKING.*CHANGELOG\.md/.test(line));
  if (at === -1) return undefined;
  for (let index = at + 1; index < lines.length && index <= at + 4; index += 1) {
    const claimed = /^#\s*(\d+)\b/.exec(lines[index] ?? '')?.[1];
    if (claimed !== undefined) return { line: index + 1, claimed: Number.parseInt(claimed, 10) };
  }
  return undefined;
}

export type ChangelogGapKind =
  | 'duplicate'
  | 'empty'
  | 'unreleased-breaking'
  | 'count'
  | 'missing-row'
  | 'total'
  | 'unscanned';

export interface ChangelogGap {
  readonly kind: ChangelogGapKind;
  readonly at: string;
  readonly detail: string;
}

export interface ChangelogInput {
  readonly changelog: string;
  readonly upgrading: string;
  /** The version this commit is tagged as, when it is tagged — `undefined` between releases. */
  readonly taggedVersion?: string | undefined;
}

export function checkChangelog(input: ChangelogInput): readonly ChangelogGap[] {
  const gaps: ChangelogGap[] = [];
  const sections = parseChangelog(input.changelog);
  const byVersion = new Map<string, ChangelogSection>();

  for (const section of sections) {
    const first = byVersion.get(section.version);
    if (first !== undefined) {
      gaps.push({
        kind: 'duplicate',
        at: `${CHANGELOG_PATH}:${section.line}`,
        detail: `a second \`## ${section.heading}\` — ${section.version} is already the section at line ${first.line}`,
      });
      continue;
    }
    byVersion.set(section.version, section);
    if (section.released && !section.filled) {
      gaps.push({
        kind: 'empty',
        at: `${CHANGELOG_PATH}:${section.line}`,
        detail: `\`## ${section.heading}\` has no body, so the release it names says nothing`,
      });
    }
  }

  const unreleased = byVersion.get(UNRELEASED);
  const stranded = unreleased?.breaking ?? 0;
  if (input.taggedVersion !== undefined && stranded > 0) {
    gaps.push({
      kind: 'unreleased-breaking',
      at: `${CHANGELOG_PATH}:${unreleased?.line ?? 1}`,
      detail: `${stranded} \`BREAKING —\` ${stranded === 1 ? 'entry sits' : 'entries sit'} under [Unreleased] at tag ${input.taggedVersion}, so the migration is not in ${input.taggedVersion}'s own section`,
    });
  }

  const rows = parseMigrationTable(input.upgrading);
  const single = rows.filter((row) => row.target !== undefined);
  if (single.length === 0) {
    gaps.push({
      kind: 'unscanned',
      at: UPGRADING_PATH,
      detail: 'no row sends the reader to a single version section, so this rule read nothing',
    });
    return gaps;
  }

  for (const row of single) {
    const section = byVersion.get(row.target ?? '');
    const actual = section?.breaking ?? 0;
    if (row.claimed === actual && section !== undefined) continue;
    gaps.push({
      kind: 'count',
      at: `${UPGRADING_PATH}:${row.line}`,
      detail:
        section === undefined
          ? `names a \`${row.target}\` section that ${CHANGELOG_PATH} does not have`
          : `claims ${row.claimed} breaking entries; the \`${row.target}\` section of ${CHANGELOG_PATH} holds ${actual}`,
    });
  }

  const expectedTotal = single.reduce(
    (sum, row) => sum + (byVersion.get(row.target ?? '')?.breaking ?? 0),
    0,
  );
  for (const row of rows.filter((candidate) => candidate.aggregate)) {
    if (row.claimed === expectedTotal) continue;
    gaps.push({
      kind: 'count',
      at: `${UPGRADING_PATH}:${row.line}`,
      detail: `claims ${row.claimed} breaking entries in all; the per-major sections hold ${expectedTotal}`,
    });
  }

  // A major with no row is the 6.0.0 failure one step earlier: released, and no upgrade guide.
  for (const section of sections) {
    const major = /^(\d+)\.0\.0$/.exec(section.version)?.[1];
    if (major === undefined || Number.parseInt(major, 10) < FIRST_MIGRATABLE_MAJOR) continue;
    if (single.some((row) => row.target === section.version)) continue;
    gaps.push({
      kind: 'missing-row',
      at: `${UPGRADING_PATH}:1`,
      detail: `${section.version} is a released major and no row sends the reader to its section`,
    });
  }

  const derived = parseDerivedTotal(input.upgrading);
  const wholeFile = sections.reduce((sum, section) => sum + section.breaking, 0);
  if (derived !== undefined && derived.claimed !== wholeFile) {
    gaps.push({
      kind: 'total',
      at: `${UPGRADING_PATH}:${derived.line}`,
      detail: `promises the grep prints ${derived.claimed}; it prints ${wholeFile}`,
    });
  }
  return gaps;
}

const RERUN = 'bun run scripts/changelog-check.ts --json';

export function changelogFinding(gap: ChangelogGap): Finding {
  if (gap.kind === 'duplicate' || gap.kind === 'empty') {
    return {
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause: `${gap.at} ${gap.detail}`,
      fix: `merge the two sections into one, or delete the generated one, then rerun: ${RERUN}`,
      at: gap.at,
    };
  }
  if (gap.kind === 'unreleased-breaking') {
    return {
      code: 'X_DOC_CHANGELOG_UNRELEASED_BREAKING',
      cause: `${gap.at} ${gap.detail}`,
      // `--dry-run` writes NOTHING (release.ts, `if (!dryRun)`), so naming it here handed the
      // reader a command that validates the promotion and does not perform it. Axiom 4 at the one
      // point it is read: state the edit, and say which command performs it and which only checks.
      fix: 'move those entries under the released version heading in CHANGELOG.md — a release performs this promotion (bun run scripts/release.ts --bump major), and --dry-run only validates it',
      at: gap.at,
    };
  }
  if (gap.kind === 'unscanned') {
    return {
      code: 'X_DOC_MIGRATION_UNSCANNED',
      cause: `${gap.at} ${gap.detail}`,
      // A literal path, never an interpolation: the fix-line rule reads these statically.
      fix: 'restore the summary table in wiki/Upgrading.md — each row reads "the `X.Y.Z` section, in order"',
      at: UPGRADING_PATH,
    };
  }
  return {
    code: 'X_DOC_MIGRATION_COUNT_STALE',
    cause: `${gap.at} ${gap.detail}`,
    fix: `set that count from the section it names, never from the whole file: ${RERUN}`,
    at: gap.at,
  };
}

/** The tag on THIS commit, when there is one — the only moment [Unreleased] must be migration-free. */
export async function taggedVersion(root: string): Promise<string | undefined> {
  const tags = await run(['git', 'tag', '--points-at', 'HEAD'], { cwd: root });
  if (!tags.ok) return undefined;
  return tags.output
    .split('\n')
    .map((line) => /^v(\d+\.\d+\.\d+)$/.exec(line.trim())?.[1])
    .find((version) => version !== undefined);
}

export async function changelogGaps(root: string): Promise<readonly ChangelogGap[]> {
  return checkChangelog({
    changelog: await Bun.file(`${root}/${CHANGELOG_PATH}`).text(),
    upgrading: await Bun.file(`${root}/${UPGRADING_PATH}`).text(),
    taggedVersion: await taggedVersion(root),
  });
}

/** Every finding this rule contributes, for a caller that folds it into a gate step. */
export const changelogFindings = async (root: string): Promise<readonly Finding[]> =>
  (await changelogGaps(root)).map(changelogFinding);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await changelogFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${CHANGELOG_PATH} sections are well-formed and every ${UPGRADING_PATH} count is read from its own section`
          : `${findings.length} finding(s): the changelog and the upgrade guide disagree`,
      findings,
    },
    args.json,
  );
}
