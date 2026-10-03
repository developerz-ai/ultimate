// `changelog-pairing.ts`, each rule against a fixture that breaks exactly it — then the two files
// this repo ships, which is the assertion that makes it a gate rather than a demo.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { BREAKING_ENTRY, CHANGELOG_PATH, UPGRADING_PATH } from '../changelog-check';
import * as format from './changelog-format';
import type { PairingGap } from './changelog-pairing';
import {
  checkPairing,
  KEYED as KEY_PATTERN,
  numbersIn,
  pairingFinding,
  parseWalkthroughs,
} from './changelog-pairing';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const changelog = (lines: readonly string[]): string =>
  [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Changed',
    '',
    ...lines,
    '',
    '## 23.0.0 - x',
    '',
  ].join('\n');

const upgrading = (options: {
  readonly lead?: string;
  readonly intro?: string;
  readonly rows?: number;
  readonly entriesCell?: string;
}): string =>
  [
    '# Upgrading',
    '',
    '## 23.x → 24.0.0, entry by entry — **unreleased**',
    '',
    options.lead ?? 'Two entries. **An operator step: entry 2, upgrade step 1.**',
    '',
    '### The upgrade, top to bottom',
    '',
    '| # | Do | What you see | Entries |',
    '|---|---|---|---|',
    `| 1 | upgrade | nothing | ${options.entriesCell ?? '1, 2'} |`,
    '',
    '### Entry by entry',
    '',
    options.intro ?? 'Tier 0 — `@ultimat3/schema` (1), `@ultimat3/core` (2).',
    '',
    '| # | Surface | Costs you an edit if |',
    '|---|---|---|',
    ...Array.from({ length: options.rows ?? 2 }, (_, n) => `| ${String(n + 1)} | s | e |`),
    '',
    '| Order | Do |',
    '|---|---|',
    '| 7 | an operator table, numbering something else |',
    '',
  ].join('\n');

const KEYED = ['- **BREAKING — (#1) one.** text', '- **BREAKING — (#2) two.** text'];

const kinds = (gaps: readonly PairingGap[]): readonly string[] =>
  gaps.map((gap) => `${gap.kind}: ${gap.detail}`);

describe('one statement of the format', () => {
  test('the count rule and the pairing rule read the same BREAKING prefix and the same paths', () => {
    // Re-exported, never redeclared: a prefix changed in one file only would make the count rule
    // and the pairing rule read different lines.
    expect(BREAKING_ENTRY).toBe(format.BREAKING_ENTRY);
    expect(KEY_PATTERN.source.startsWith(format.BREAKING_ENTRY.source)).toBe(true);
    expect([CHANGELOG_PATH, UPGRADING_PATH]).toEqual([
      format.CHANGELOG_PATH,
      format.UPGRADING_PATH,
    ]);
  });
});

describe('pairing', () => {
  test('keyed lines and rows that agree are clean — a later table is not the entry table', () => {
    expect(checkPairing(changelog(KEYED), upgrading({}))).toEqual([]);
  });

  test('an unkeyed BREAKING line is X_DOC_MIGRATION_UNPAIRED, naming the line', () => {
    const gaps = checkPairing(
      changelog(['- **BREAKING — (#1) one.**', '- **BREAKING — two.**']),
      upgrading({}),
    );
    expect(kinds(gaps).join('\n')).toContain(
      '1 BREAKING line(s) in [Unreleased] name no Upgrading entry',
    );
    expect(kinds(gaps).join('\n')).toContain('row 2 named by no BREAKING line');
    expect(pairingFinding(gaps[0] ?? expect.unreachable()).code).toBe('X_DOC_MIGRATION_UNPAIRED');
  });

  test('a key named twice, a key with no row, and keys out of order are each named', () => {
    const twice = checkPairing(changelog([KEYED[0] ?? '', KEYED[0] ?? '']), upgrading({}));
    expect(kinds(twice).join('\n')).toContain('#1 named twice');
    const orphan = checkPairing(
      changelog([...KEYED, '- **BREAKING — (#3) three.**']),
      upgrading({}),
    );
    expect(kinds(orphan).join('\n')).toContain('#3 named and no such row');
    const swapped = checkPairing(changelog([KEYED[1] ?? '', KEYED[0] ?? '']), upgrading({}));
    expect(kinds(swapped).join('\n')).toContain('#1 out of order');
  });

  test('one line added on EACH side — the case the count rule cannot see — is unpaired', () => {
    // Three lines, three rows: the count agrees. The third line names a row the table does not
    // number as its own change.
    const gaps = checkPairing(
      changelog([...KEYED, '- **BREAKING — (#2) a second claim on row 2.**']),
      upgrading({ rows: 3, intro: '(1–3)', entriesCell: '1' }),
    );
    expect(kinds(gaps).join('\n')).toContain('#2 named twice');
    expect(kinds(gaps).join('\n')).toContain('row 3 named by no BREAKING line');
  });

  test('a walkthrough with no `| # |` table pairs with nothing', () => {
    const page = upgrading({}).replace('| # | Surface', '| No | Surface');
    expect(kinds(checkPairing(changelog(KEYED), page))[0]).toContain(
      'has no "### Entry by entry" table',
    );
  });

  test('a major below the floor is not read — its walkthrough predates the table', () => {
    const old = upgrading({}).replace(
      '23.x → 24.0.0, entry by entry — **unreleased**',
      '21.x → 22.0.0, entry by entry',
    );
    const text = changelog([]).replace(
      '## 23.0.0 - x',
      '## 22.0.0 - x\n\n- **BREAKING — unkeyed.**',
    );
    expect(checkPairing(text, old)).toEqual([]);
  });
});

describe('ranges', () => {
  test('an Entries cell naming a row the table lacks is X_DOC_MIGRATION_RANGE_STALE', () => {
    const gaps = checkPairing(changelog(KEYED), upgrading({ entriesCell: '1, 2–4' }));
    expect(kinds(gaps)).toEqual([
      "range: cites entry 3, 4, which the walkthrough's Entry by entry table has no row for",
    ]);
    expect(pairingFinding(gaps[0] ?? expect.unreachable()).code).toBe(
      'X_DOC_MIGRATION_RANGE_STALE',
    );
  });

  test('a lead callout naming a missing entry or upgrade step is named', () => {
    const page = upgrading({ lead: '**Operator: entries 2–3, upgrade steps 1 and 4.**' });
    expect(kinds(checkPairing(changelog(KEYED), page))).toEqual([
      "range: cites entry 3, which the walkthrough's Entry by entry table has no row for",
      "range: cites step 4, which the walkthrough's upgrade-step table has no row for",
    ]);
  });

  test('the intro package ranges must cover every row exactly once', () => {
    const gap = checkPairing(changelog(KEYED), upgrading({ intro: '`a` (1), `b` (1)' }));
    expect(kinds(gap)).toEqual([
      "range: the Entry by entry intro's package ranges must cover every row once: row 2 in no range; row 1 in two",
    ]);
  });

  test('numbersIn reads en dashes, hyphens, commas and "and"; a backwards range cites nothing real', () => {
    expect(numbersIn('3–5, 7 and 9-10')).toEqual([3, 4, 5, 7, 9, 10]);
    expect(numbersIn('5–3').some(Number.isNaN)).toBe(true);
  });
});

describe('the committed CHANGELOG.md and wiki/Upgrading.md', () => {
  test('pair one-to-one, and every number they cite is a row — read, not vacuous', async () => {
    const root = repoRoot();
    const log = await Bun.file(`${root}/CHANGELOG.md`).text();
    const page = await Bun.file(`${root}/wiki/Upgrading.md`).text();
    const paired = parseWalkthroughs(page).filter((walk) => walk.entries.length > 0);
    // 23.0.0 and the in-flight major at least, each with a table of rows and cited numbers.
    expect(paired.length).toBeGreaterThanOrEqual(2);
    for (const walk of paired) expect(walk.citations.length).toBeGreaterThan(0);
    expect(checkPairing(log, page)).toEqual([]);
  });
});
