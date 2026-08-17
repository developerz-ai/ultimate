// The gate step that keeps `packages/http/src/error-map.ts`'s status table closed. Every case here
// is a FIXTURE, never an edit to the real table: a check proven only against a green tree is a
// check that has never been shown to fail, and this one exists because eleven codes fell through
// to 500 unnoticed for a year.

import { describe, expect, test } from 'bun:test';
import {
  BACKLOG_FILE,
  checkStatusTable,
  type DeclaredCode,
  ERROR_MAP_FILE,
  errorStatusCompleteness,
  type StatusTableInput,
  statusGapFindingFor,
} from './error-map';
import { backlogCodes, ERROR_STATUS_BACKLOG } from './error-map-backlog';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const at = (owner: string): string => `packages/${owner}/src/errors.ts`;

const code = (name: string, owner: string): DeclaredCode => ({
  code: name,
  owner,
  at: at(owner),
});

/** A tree with one action code and one CLI code, no rows and no pins, unless overridden. */
const tree = (over: Partial<StatusTableInput> = {}): StatusTableInput => ({
  declared: [code('X_FIXTURE_ACTION', 'action'), code('X_FIXTURE_CLI', 'cli')],
  status: {},
  backlog: {},
  ...over,
});

const findings = (input: StatusTableInput) => checkStatusTable(input).map(statusGapFindingFor);

describe('unit · a framework code with no status row', () => {
  test('is refused, and the fix names both files that can resolve it', () => {
    const found = findings(tree());

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_ERROR_STATUS_MISSING');
    // The whole point of the row: without it the caller is told the SERVER broke.
    expect(found[0]?.cause).toContain('X_FIXTURE_ACTION');
    expect(found[0]?.cause).toContain('answers 500');
    expect(found[0]?.fix).toContain(ERROR_MAP_FILE);
    expect(found[0]?.fix).toContain(BACKLOG_FILE);
    // Points at the declaration, so "where does this come from?" is not a grep.
    expect(found[0]?.at).toBe(at('action'));
  });

  test('passes once the row exists', () => {
    expect(findings(tree({ status: { X_FIXTURE_ACTION: 409 } }))).toEqual([]);
  });

  test('passes once it is pinned, and the pin is the only other way through', () => {
    expect(findings(tree({ backlog: { action: ['X_FIXTURE_ACTION'] } }))).toEqual([]);
  });

  test('a tier 5 owner is out of scope — `cli` never answers a request', () => {
    // `X_FIXTURE_CLI` is in every fixture above and never reported. If this ever fails, the scope
    // widened and ~80 build-time CLI codes just became gate findings.
    expect(findings(tree()).map((one) => one.cause)).not.toContain('X_FIXTURE_CLI');
  });

  test('an owner no tier table places is out of scope, not a crash', () => {
    expect(findings(tree({ declared: [code('X_FIXTURE_STRAY', 'scripts')] }))).toEqual([]);
  });
});

describe('unit · the ratchet may only shrink', () => {
  test('a pin whose row now exists is stale, and the fix names the group to edit', () => {
    const found = findings(
      tree({
        status: { X_FIXTURE_ACTION: 409 },
        backlog: { action: ['X_FIXTURE_ACTION'] },
      }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_ERROR_STATUS_BACKLOG_STALE');
    expect(found[0]?.cause).toContain('409');
    expect(found[0]?.fix).toBe(
      `delete 'X_FIXTURE_ACTION' from the action group in ${BACKLOG_FILE}`,
    );
  });

  test('a pin for a code nobody declares any more is stale too', () => {
    const found = findings(tree({ backlog: { action: ['X_FIXTURE_DELETED'] } }));

    expect(found).toHaveLength(2);
    const stale = found.find((one) => one.cause.includes('X_FIXTURE_DELETED'));
    expect(stale?.code).toBe('X_ERROR_STATUS_BACKLOG_STALE');
    expect(stale?.cause).toContain('declares it any more');
  });
});

describe('unit · a row nothing declares', () => {
  test('is refused — a mistyped row maps nothing and the real code still answers 500', () => {
    const found = findings(tree({ status: { X_FIXTURE_ACTION: 409, X_FIXTURE_ACTIO: 409 } }));

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_ERROR_STATUS_UNKNOWN_CODE');
    expect(found[0]?.cause).toContain('X_FIXTURE_ACTIO');
    expect(found[0]?.at).toBe(ERROR_MAP_FILE);
  });
});

describe('unit · the findings are gate-shaped', () => {
  test('every finding carries a code, a cause and a fix that is an edit or a command', () => {
    const found = findings(
      tree({
        status: { X_FIXTURE_ORPHAN: 400 },
        backlog: { action: ['X_FIXTURE_DELETED'] },
      }),
    );

    expect(found.length).toBeGreaterThan(2);
    for (const finding of found) {
      expect(finding.code).toStartWith('X_');
      expect(finding.cause.length).toBeGreaterThan(0);
      // The `errors` step's own rule: a fix is a command or an edit naming a file.
      expect(finding.fix).toMatch(/\.ts\b/);
    }
  });

  test('the report is ordered by code, so two runs of one tree diff to nothing', () => {
    const input = tree({
      declared: [code('X_FIXTURE_B', 'action'), code('X_FIXTURE_A', 'entity')],
    });
    expect(checkStatusTable(input).map((one) => one.code)).toEqual(['X_FIXTURE_A', 'X_FIXTURE_B']);
  });
});

describe('unit · this repo', () => {
  /**
   * The ratchet's own hygiene against the REAL tree: no pin has been resolved and left behind, and
   * no row names a code nobody declares. Deliberately NOT the `missing` rule — that is the live
   * gate step (`errorContract` in `scripts/verify.ts`), and asserting it here would duplicate the
   * step and report another package's in-flight code as this file's failure.
   *
   * Full-repo scan, so `REPO_SCAN_TIMEOUT_MS`.
   */
  test(
    'has no stale pins and no rows for codes nothing declares',
    async () => {
      const found = await errorStatusCompleteness(repoRoot());
      const noise = found.filter((one) => one.code !== 'X_ERROR_STATUS_MISSING');
      expect(noise).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('pins every code once — a code in two groups reads as two decisions', () => {
    const flat = Object.values(ERROR_STATUS_BACKLOG).flat();
    expect(flat.length).toBe(backlogCodes().size);
  });
});
