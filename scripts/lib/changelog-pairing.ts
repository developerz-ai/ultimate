// Single responsibility: `changelog-check`'s PAIRING rule — each `BREAKING —` line of a CHANGELOG
// section names the wiki/Upgrading.md entry that migrates it, one-to-one, and every entry or step
// number a walkthrough cites is a row it has. The count rule proves both sides hold as many; only a
// key proves line 57 and row 57 are the same change.

import type { Finding } from './log';

/**
 * THE KEY: `(#N)` straight after the dash — `- **BREAKING — (#57) …` — N the row in that major's
 * `### Entry by entry` table. A number the author writes, never one inferred from order: inferring
 * it is the count rule again, blind to one line added on each side. The prefix is `BREAKING_ENTRY`'s.
 */
const KEYED = /^(?:- \*\*|### )BREAKING — \(#(\d+)\)/;
const ENTRY = /^(?:- \*\*|### )BREAKING —/;
const WALKTHROUGH = /^## .*→ (\d+\.\d+\.\d+), entry by entry(.*)$/;
const CHANGELOG_PATH = 'CHANGELOG.md';
const UPGRADING_PATH = 'wiki/Upgrading.md';
/** Lines a finding spells out before it says how many more. */
const LISTED = 8;
/**
 * The first major whose walkthrough is a `| # |` table and whose CHANGELOG lines carry keys. The
 * majors below it walk their entries as `### 1.` headings or as grouped "Entries 4, 5, 6" prose,
 * shipped and archived in that shape — keying them is rewriting history no reader is upgrading
 * through any more. A floor, so every major from here on is paired.
 */
export const FIRST_PAIRED_MAJOR = 23;

interface BreakingLine {
  readonly line: number;
  readonly key: number | undefined;
}

/** `unreleased` or the section's semver, per CHANGELOG `## ` heading, with its BREAKING lines. */
export function breakingBySection(changelog: string): ReadonlyMap<string, readonly BreakingLine[]> {
  const out = new Map<string, BreakingLine[]>();
  let current: BreakingLine[] | undefined;
  changelog.split('\n').forEach((text, index) => {
    if (text.startsWith('## ')) {
      const heading = text.slice(3).trim();
      const version = /^\[unreleased\]/i.test(heading)
        ? 'unreleased'
        : (/^\[?(\d+\.\d+\.\d+)\]?/.exec(heading)?.[1] ?? heading);
      current = [];
      out.set(version, current);
      return;
    }
    if (current === undefined || !ENTRY.test(text)) return;
    const key = KEYED.exec(text)?.[1];
    current.push({ line: index + 1, key: key === undefined ? undefined : Number(key) });
  });
  return out;
}

export interface Walkthrough {
  /** The CHANGELOG section it migrates: `unreleased` for the in-flight major. */
  readonly section: string;
  readonly line: number;
  /** Row numbers of `### Entry by entry`'s table, in page order; empty when it has none. */
  readonly entries: readonly number[];
  /** Row numbers of `### The upgrade, top to bottom`'s table. */
  readonly steps: readonly number[];
  /** Every cited number: `{ line, cites, kind }` — an Entries cell, the intro ranges, a callout. */
  readonly citations: readonly Citation[];
  /** The `(1–5)` package ranges of the `### Entry by entry` intro, which must cover every row once. */
  readonly ranges: readonly number[];
}

export interface Citation {
  readonly line: number;
  readonly kind: 'entry' | 'step';
  readonly numbers: readonly number[];
}

/** `3–6, 9 and 12` → `[3, 4, 5, 6, 9, 12]`. A backwards range yields nothing, so it cites nothing. */
export function numbersIn(list: string): readonly number[] {
  const out: number[] = [];
  for (const part of list.split(/,|\band\b/)) {
    const [from, to] = part.split(/[–-]/).map((side) => Number.parseInt(side.trim(), 10));
    if (from === undefined || Number.isNaN(from)) continue;
    const last = to === undefined || Number.isNaN(to) ? from : to;
    for (let n = from; n <= last; n += 1) out.push(n);
    if (last < from) out.push(Number.NaN);
  }
  return out;
}

const NUMBER_LIST = String.raw`(\d+(?:\s*[–-]\s*\d+)?(?:(?:,\s*|\s+and\s+)\d+(?:\s*[–-]\s*\d+)?)*)`;
const ENTRY_CALLOUT = new RegExp(String.raw`\bentr(?:y|ies)\s+${NUMBER_LIST}`, 'gi');
const STEP_CALLOUT = new RegExp(String.raw`\bupgrade\s+steps?\s+${NUMBER_LIST}`, 'gi');
const ROW = /^\|\s*(\d+)\s*\|/;

/** One walkthrough's lines, from its `## ` heading to the next. */
function readWalkthrough(lines: readonly string[], start: number, section: string): Walkthrough {
  const entries: number[] = [];
  const steps: number[] = [];
  const citations: Citation[] = [];
  const ranges: number[] = [];
  let sub = '';
  let inTable = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.startsWith('## ')) break;
    if (text.startsWith('### ')) {
      sub = text.slice(4).trim();
      inTable = false;
      continue;
    }
    const row = ROW.exec(text)?.[1];
    const line = index + 1;
    if (sub === '') {
      for (const m of text.matchAll(ENTRY_CALLOUT)) {
        citations.push({ line, kind: 'entry', numbers: numbersIn(m[1] ?? '') });
      }
      for (const m of text.matchAll(STEP_CALLOUT)) {
        citations.push({ line, kind: 'step', numbers: numbersIn(m[1] ?? '') });
      }
    } else if (sub === 'Entry by entry') {
      // The FIRST `| # |` table only, ended by its first non-row line: an operator table further
      // down ("| Order | Do |") numbers something else.
      if (inTable && !text.startsWith('|')) inTable = false;
      if (text.startsWith('| # |')) inTable = entries.length === 0;
      else if (inTable && row !== undefined) entries.push(Number(row));
      else if (!inTable && entries.length === 0) {
        for (const m of text.matchAll(/\((\d+(?:\s*[–-]\s*\d+)?)\)/g)) {
          const numbers = numbersIn(m[1] ?? '');
          ranges.push(...numbers);
          citations.push({ line, kind: 'entry', numbers });
        }
      }
    } else if (sub === 'The upgrade, top to bottom' && row !== undefined) {
      steps.push(Number(row));
      const cells = text.split(/(?<!\\)\|/);
      const last = (cells.at(-2) ?? '').trim();
      if (last !== '—' && last !== '') {
        citations.push({ line, kind: 'entry', numbers: numbersIn(last) });
      }
    }
  }
  return { section, line: start + 1, entries, steps, citations, ranges };
}

export function parseWalkthroughs(upgrading: string): readonly Walkthrough[] {
  const lines = upgrading.split('\n');
  const out: Walkthrough[] = [];
  lines.forEach((text, index) => {
    const match = WALKTHROUGH.exec(text);
    if (match === null) return;
    const section = /unreleased/i.test(match[2] ?? '') ? 'unreleased' : (match[1] ?? '');
    out.push(readWalkthrough(lines, index, section));
  });
  return out;
}

export interface PairingGap {
  readonly kind: 'unpaired' | 'range';
  readonly at: string;
  readonly detail: string;
}

const listed = (items: readonly (number | string)[]): string =>
  items.length <= LISTED
    ? items.join(', ')
    : `${items.slice(0, LISTED).join(', ')} … and ${String(items.length - LISTED)} more`;

/** Keys against rows, for one section that has both. */
function pairSection(walk: Walkthrough, lines: readonly BreakingLine[]): readonly PairingGap[] {
  const gaps: PairingGap[] = [];
  const at = `${CHANGELOG_PATH}:${String(lines[0]?.line ?? 1)}`;
  const name = walk.section === 'unreleased' ? '[Unreleased]' : walk.section;
  const unkeyed = lines.filter((one) => one.key === undefined).map((one) => one.line);
  if (unkeyed.length > 0) {
    gaps.push({
      kind: 'unpaired',
      at: `${CHANGELOG_PATH}:${String(unkeyed[0])}`,
      detail: `${String(unkeyed.length)} BREAKING line(s) in ${name} name no Upgrading entry — no "(#N)" after the dash, at line ${listed(unkeyed)}`,
    });
  }
  const keys = lines.flatMap((one) => (one.key === undefined ? [] : [one.key]));
  const rows = new Set(walk.entries);
  const seen = new Set<number>();
  const twice: number[] = [];
  for (const key of keys) {
    if (seen.has(key)) twice.push(key);
    seen.add(key);
  }
  const orphanKeys = keys.filter((key) => !rows.has(key));
  const orphanRows = walk.entries.filter((row) => !seen.has(row));
  const backwards = keys.filter((key, index) => index > 0 && key <= (keys[index - 1] ?? 0));
  const problems = [
    twice.length > 0 ? `#${listed(twice)} named twice` : '',
    orphanKeys.length > 0 ? `#${listed(orphanKeys)} named and no such row` : '',
    orphanRows.length > 0 ? `row ${listed(orphanRows)} named by no BREAKING line` : '',
    backwards.length > 0 ? `#${listed(backwards)} out of order` : '',
  ].filter((text) => text !== '');
  if (problems.length > 0) {
    gaps.push({
      kind: 'unpaired',
      at,
      detail: `${name}'s BREAKING lines and the Entry by entry table at ${UPGRADING_PATH}:${String(walk.line)} do not pair one-to-one: ${problems.join('; ')}`,
    });
  }
  return gaps;
}

/** Every cited number is a row; the intro's package ranges cover each row exactly once. */
function rangeGaps(walk: Walkthrough): readonly PairingGap[] {
  const gaps: PairingGap[] = [];
  const entries = new Set(walk.entries);
  const steps = new Set(walk.steps);
  for (const cite of walk.citations) {
    const pool = cite.kind === 'entry' ? entries : steps;
    const absent = cite.numbers.filter((n) => !pool.has(n));
    if (absent.length === 0) continue;
    gaps.push({
      kind: 'range',
      at: `${UPGRADING_PATH}:${String(cite.line)}`,
      detail: `cites ${cite.kind} ${listed(absent.map((n) => (Number.isNaN(n) ? 'a backwards range' : String(n))))}, which the walkthrough's ${cite.kind === 'entry' ? 'Entry by entry' : 'upgrade-step'} table has no row for`,
    });
  }
  if (walk.ranges.length === 0) return gaps;
  const counted = new Map<number, number>();
  for (const n of walk.ranges) counted.set(n, (counted.get(n) ?? 0) + 1);
  const uncovered = walk.entries.filter((row) => !counted.has(row));
  const doubled = [...counted].filter(([, times]) => times > 1).map(([n]) => n);
  if (uncovered.length > 0 || doubled.length > 0) {
    gaps.push({
      kind: 'range',
      at: `${UPGRADING_PATH}:${String(walk.line)}`,
      detail: `the Entry by entry intro's package ranges must cover every row once: ${[uncovered.length > 0 ? `row ${listed(uncovered)} in no range` : '', doubled.length > 0 ? `row ${listed(doubled)} in two` : ''].filter((text) => text !== '').join('; ')}`,
    });
  }
  return gaps;
}

/**
 * Pure. Pairs every walkthrough whose CHANGELOG section is still in the file — an archived major
 * has nothing to pair against, which is the retention rule `changelog-check.ts` already states.
 */
export function checkPairing(changelog: string, upgrading: string): readonly PairingGap[] {
  const sections = breakingBySection(changelog);
  const gaps: PairingGap[] = [];
  for (const walk of parseWalkthroughs(upgrading)) {
    const major = Number.parseInt(walk.section, 10);
    if (walk.section !== 'unreleased' && !(major >= FIRST_PAIRED_MAJOR)) continue;
    const lines = sections.get(walk.section);
    if (lines === undefined || lines.length === 0) continue;
    if (walk.entries.length === 0) {
      gaps.push({
        kind: 'unpaired',
        at: `${UPGRADING_PATH}:${String(walk.line)}`,
        detail: `the walkthrough for ${walk.section} has no "### Entry by entry" table with a "| # |" column, so its ${String(lines.length)} BREAKING line(s) pair with nothing`,
      });
      continue;
    }
    gaps.push(...pairSection(walk, lines), ...rangeGaps(walk));
  }
  return gaps;
}

const RERUN = 'bun run scripts/changelog-check.ts --json';

export function pairingFinding(gap: PairingGap): Finding {
  if (gap.kind === 'range') {
    return {
      code: 'X_DOC_MIGRATION_RANGE_STALE',
      cause: `${gap.at} ${gap.detail}`,
      fix: `edit ${gap.at} so it names rows the walkthrough has, then rerun: ${RERUN}`,
      at: gap.at,
    };
  }
  return {
    code: 'X_DOC_MIGRATION_UNPAIRED',
    cause: `${gap.at} ${gap.detail}`,
    fix: `write "(#N)" after the dash of each BREAKING line in CHANGELOG.md, N its row in that major's Entry by entry table in ${UPGRADING_PATH}, then rerun: ${RERUN}`,
    at: gap.at,
  };
}
