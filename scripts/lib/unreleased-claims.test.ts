import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { UNRELEASED_CLAIM_PINS } from './unreleased-claim-pins';
import { claimGaps, datedVersions, treeClaims, unreleasedClaims } from './unreleased-claims';

const CHANGELOG = [
  '## [Unreleased]',
  '',
  '## 21.0.0 - 2026-09-23',
  '',
  '## 20.2.1 - 2026-09-19',
].join('\n');
const DATED = datedVersions(CHANGELOG);

describe('unit · "unreleased" beside a version CHANGELOG.md has dated', () => {
  test('only a dated heading counts as released', () => {
    expect([...DATED]).toEqual(['21.0.0', '20.2.1']);
  });

  test('a dated version called unreleased is a claim, in either order and across a wrap', () => {
    const text = [
      'Built, `As of 2026-09-22` (21.0.0, unreleased).',
      'unreleased until 20.2.1 shipped',
      'the socket counts it (21.0.0,',
      'unreleased). Next line.',
    ].join('\n');
    expect(unreleasedClaims('p.md', text, DATED).map((c) => c.line)).toEqual([1, 2, 4]);
  });

  test('the [Unreleased] heading name, an undated version and a far version are not claims', () => {
    const text = [
      'it lives under `[Unreleased]` in CHANGELOG.md, beside 21.0.0',
      '22.0.0 (unreleased) is the next major',
      `21.0.0 ${'x'.repeat(60)} unreleased`,
    ].join('\n');
    expect(unreleasedClaims('p.md', text, DATED)).toEqual([]);
  });

  test('over its pin is X_DOC_UNRELEASED_STALE; under it is X_DOC_UNRELEASED_PIN_STALE', () => {
    const claims = unreleasedClaims('p.md', '(21.0.0, unreleased)\n(20.2.1, unreleased)', DATED);
    const both = { 'p.md: 21.0.0': 1, 'p.md: 20.2.1': 1 };
    expect(claimGaps(claims, { 'p.md: 21.0.0': 1 }).map((gap) => gap.code)).toEqual([
      'X_DOC_UNRELEASED_STALE',
    ]);
    expect(claimGaps(claims, both)).toEqual([]);
    expect(claimGaps([], both).map((gap) => gap.code)).toEqual([
      'X_DOC_UNRELEASED_PIN_STALE',
      'X_DOC_UNRELEASED_PIN_STALE',
    ]);
  });

  test('a pin is per page AND version: a swapped claim at an equal count is still new', () => {
    // A per-page count let the 20.2.1 line be fixed and a 21.0.0 one written in its place.
    const swapped = unreleasedClaims('p.md', '(21.0.0, unreleased)', DATED);
    const gaps = claimGaps(swapped, { 'p.md: 20.2.1': 1 });
    expect(gaps.map((gap) => gap.code).sort()).toEqual([
      'X_DOC_UNRELEASED_PIN_STALE',
      'X_DOC_UNRELEASED_STALE',
    ]);
    expect(gaps.find((gap) => gap.code === 'X_DOC_UNRELEASED_PIN_STALE')?.fix).toContain(
      "'p.md: 20.2.1'",
    );
  });
});

describe('the real tree', () => {
  test(
    'is on the ratchet, and the scan really read pages',
    async () => {
      const root = repoRoot();
      const claims = await treeClaims(root, await Bun.file(`${root}/CHANGELOG.md`).text());
      expect(claimGaps(claims)).toEqual([]);
      // Non-vacuity: while the table holds rows, the scan must be finding the lines they pin.
      const pinned = Object.values(UNRELEASED_CLAIM_PINS).reduce((sum, n) => sum + n, 0);
      expect(claims.length).toBe(pinned);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
