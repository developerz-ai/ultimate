// Both directions of the never-ships parenthesis, each proved against a fixture that breaks exactly
// it — then the real `wiki/Error-Codes.md`, which is the assertion that makes this a gate.

import { describe, expect, test } from 'bun:test';
import {
  checkGateCodes,
  gateCodeFinding,
  neverShipsList,
  scriptDeclaredCodes,
  tableRows,
} from './gate-codes';
import { GATE_CODE_NO_ROW, GATE_CODE_UNLISTED } from './gate-codes-backlog';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

/** A page that satisfies both directions: one listed code, one wildcard family, both with rows. */
const PAGE = [
  '# Error codes',
  '',
  "…with one exception the gate knows about: this repository's own gate scripts (`X_ROADMAP_*`,",
  '`X_GATE_ONE`) never ship, so no package may own them. See Troubleshooting.',
  '',
  '| Code | Meaning | Cause | Fix |',
  '|---|---|---|---|',
  '| `X_GATE_ONE` | a thing | a cause | a fix |',
  '| `X_ROADMAP_STALE` | a thing | a cause naming `X_GATE_TWO` | a fix |',
  '',
].join('\n');

const check = (
  page: string,
  declared: readonly string[],
  pins: Partial<{ noRow: string[]; unlisted: string[] }> = {},
) =>
  checkGateCodes({
    declared,
    page,
    noRowPins: pins.noRow ?? [],
    unlistedPins: pins.unlisted ?? [],
  });

describe('parsing', () => {
  test('the list stops at the closing bracket, not at the end of the page', () => {
    expect([...neverShipsList(PAGE)].sort()).toEqual(['X_GATE_ONE', 'X_ROADMAP_*']);
  });

  test('no lead sentence means no list, never the whole page', () => {
    expect(neverShipsList('# Error codes\n\n| `X_GATE_ONE` | a | b | c |\n').size).toBe(0);
  });

  // The hole `documentedCodes` leaves open: a code named inside ANOTHER row's cause counts as
  // documented today, which is how a code can be "documented" with no row of its own.
  test('a row is the FIRST cell, never a mention inside someone else cause', () => {
    expect([...tableRows(PAGE)].sort()).toEqual(['X_GATE_ONE', 'X_ROADMAP_STALE']);
    expect(tableRows(PAGE).has('X_GATE_TWO')).toBe(false);
  });
});

describe('the two directions', () => {
  test('the good fixture is silent, so every finding below is the mutation', () => {
    expect(check(PAGE, ['X_GATE_ONE', 'X_ROADMAP_STALE'])).toEqual([]);
  });

  test('a listed code with no table row', () => {
    const page = PAGE.replace('| `X_GATE_ONE` | a thing | a cause | a fix |\n', '');
    expect(check(page, ['X_GATE_ONE'])).toEqual([{ kind: 'no-row', code: 'X_GATE_ONE' }]);
  });

  test('a scripts-declared code the list omits', () => {
    expect(check(PAGE, ['X_GATE_ONE', 'X_REGISTRY_UNATTESTED'])).toEqual([
      { kind: 'unlisted', code: 'X_REGISTRY_UNATTESTED' },
    ]);
  });

  test('a wildcard entry covers its whole family', () => {
    expect(check(PAGE, ['X_ROADMAP_STALE', 'X_ROADMAP_ANYTHING_AT_ALL'])).toEqual([]);
  });

  test('a pin silences a finding, and only the one it names', () => {
    const page = PAGE.replace('| `X_GATE_ONE` | a thing | a cause | a fix |\n', '');
    expect(check(page, [], { noRow: ['X_GATE_ONE'] })).toEqual([]);
    expect(check(PAGE, ['X_NEW'], { unlisted: ['X_OTHER'] }).map((gap) => gap.kind)).toEqual([
      'unlisted',
      'pinned',
    ]);
  });

  test('a pin the page no longer needs is itself a finding', () => {
    expect(check(PAGE, ['X_GATE_ONE'], { noRow: ['X_GATE_ONE'] })).toEqual([
      { kind: 'pinned', code: 'X_GATE_ONE' },
    ]);
  });
});

describe('findings', () => {
  test('each kind carries a code and a fix that names the edit', () => {
    expect(gateCodeFinding({ kind: 'no-row', code: 'X_A' }).code).toBe('X_GATE_CODE_UNDOCUMENTED');
    expect(gateCodeFinding({ kind: 'unlisted', code: 'X_A' }).code).toBe(
      'X_GATE_CODE_UNDOCUMENTED',
    );
    const stale = gateCodeFinding({ kind: 'pinned', code: 'X_A' });
    expect(stale.code).toBe('X_GATE_CODE_BACKLOG_STALE');
    expect(stale.fix).toContain('scripts/gate-codes-backlog.ts');
  });
});

describe('the committed wiki/Error-Codes.md', () => {
  test(
    'is wrong about exactly the codes the backlog pins, and no others',
    async () => {
      const root = repoRoot();
      const page = await Bun.file(`${root}/wiki/Error-Codes.md`).text();
      const declared = await scriptDeclaredCodes(root);
      expect(declared.length).toBeGreaterThan(50);
      expect(
        checkGateCodes({
          declared,
          page,
          noRowPins: GATE_CODE_NO_ROW,
          unlistedPins: GATE_CODE_UNLISTED,
        }),
      ).toEqual([]);
      // Load-bearing pins: drop them all and the real page reds, so the ratchet is measuring
      // something rather than pinning an empty set.
      const unpinned = checkGateCodes({ declared, page, noRowPins: [], unlistedPins: [] });
      expect(unpinned.length).toBe(GATE_CODE_NO_ROW.length + GATE_CODE_UNLISTED.length);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
