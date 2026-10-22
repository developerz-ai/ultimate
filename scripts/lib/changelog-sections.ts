// The CHANGELOG.md / wiki/Upgrading.md PARSERS and the helpers around them. Split out of
// `scripts/changelog-check.ts` when that file crossed the 500-line ceiling: what a section LOOKS
// LIKE in markdown and what the rule FINDS in the result are two subjects, and only the second
// grades findings.
//
// The rule the parsers serve lives next door — one checker, called from the gate, that asks
// "does each section match the shape" and emits a gap per breakage. This file answers only
// "where does this page claim a section, a count, or a walkthrough".

import { BREAKING_ENTRY } from './changelog-format';

/** `## [Unreleased]` holds work that has no version yet, so the released-section rules skip it. */
export const UNRELEASED = 'unreleased';

/** Semver applies from 1.0.0, and 1.0.0 itself has nothing to migrate FROM — the table starts at 2. */
export const FIRST_MIGRATABLE_MAJOR = 2;

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
  /** The lines between this heading and the next `## `, trimmed — the body the gate grades. */
  readonly body: string;
}

const versionOf = (heading: string): string => {
  if (/^\[unreleased\]/i.test(heading)) return UNRELEASED;
  return /^\[?(\d+\.\d+\.\d+)\]?/.exec(heading)?.[1] ?? heading.toLowerCase();
};

export function parseChangelog(text: string): readonly ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const lines = text.split('\n');
  let current:
    | { heading: string; line: number; breaking: number; filled: boolean; bodyLines: string[] }
    | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    sections.push({
      heading: current.heading,
      version: versionOf(current.heading),
      released: versionOf(current.heading) !== UNRELEASED,
      line: current.line,
      breaking: current.breaking,
      filled: current.filled,
      body: current.bodyLines.join('\n').trim(),
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('## ')) {
      flush();
      current = {
        heading: line.slice(3).trim(),
        line: index + 1,
        breaking: 0,
        filled: false,
        bodyLines: [],
      };
      continue;
    }
    if (current === undefined) continue;
    current.bodyLines.push(line);
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
  /** The in-flight major's row, whose count is `[Unreleased]`'s own — DX ledger #12. */
  readonly unreleased: boolean;
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
    const unreleased = target === undefined && !aggregate && /\[Unreleased\]/.test(read);
    if (target === undefined && !aggregate && !unreleased) continue;
    rows.push({
      line: index + 1,
      claimed: Number.parseInt(claimed, 10),
      target,
      aggregate,
      unreleased,
      quote: line.trim(),
    });
  }
  return rows;
}

/**
 * The versions wiki/Upgrading.md actually WALKS, read off its `## … → X.Y.Z, entry by entry`
 * headings. A row is a promise and a heading is the thing promised, and until 2026-08-23 this rule
 * read only the row: `1.x → 2.0.0` pointed at a `2.0.0` section the page had never carried, through
 * six releases, under a green gate. Anchored on the heading's own shape rather than on the row's
 * target so that renaming the section is the failure it is.
 */
export function parseUpgradeSections(text: string): ReadonlySet<string> {
  const walked = new Set<string>();
  for (const line of text.split('\n')) {
    const version = /^## .*→ (\d+\.\d+\.\d+), entry by entry\s*$/.exec(line)?.[1];
    if (version !== undefined) walked.add(version);
  }
  return walked;
}

/**
 * The oldest released version CHANGELOG.md still carries — the RETENTION BOUNDARY, derived from the
 * file rather than configured, so trimming the file again is deleting sections and nothing else.
 *
 * CHANGELOG.md is trimmed BY HAND — older sections deleted, because they are one
 * `git show v<tag>:CHANGELOG.md` away and a file nobody scrolls is a file nobody reads. No length
 * cap is enforced (it once claimed 1,000 lines while carrying 9,654); this boundary is what makes a
 * trim safe, whenever one is made.
 * wiki/Upgrading.md is NOT trimmed with it: a reader upgrading across four majors needs every
 * walkthrough in order, where a reader of the changelog wants the last release. Two documents, two
 * jobs — so a row naming a section BELOW this boundary is the archive working, not a stale row,
 * and only a row naming a version ABOVE it and absent is the typo this rule exists to catch.
 */
export function retentionBoundary(sections: readonly ChangelogSection[]): string | undefined {
  const released = sections
    .map((section) => section.version)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  return released.length === 0 ? undefined : (released.at(-1) as string);
}

/** `11.0.0` -> `[11, 0, 0]`, for an ordering comparison that never sorts `9` above `10`. */
const versionOrder = (version: string): readonly number[] =>
  version.split('.').map((part) => Number.parseInt(part, 10));

/** True when `version` is older than `boundary` — i.e. archived out of CHANGELOG.md on purpose. */
export function isArchived(version: string, boundary: string | undefined): boolean {
  if (boundary === undefined) return false;
  const left = versionOrder(version);
  const right = versionOrder(boundary);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
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
