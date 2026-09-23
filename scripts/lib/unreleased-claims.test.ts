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
    expect(claimGaps(claims, { 'p.md': 1 }).map((gap) => gap.code)).toEqual([
      'X_DOC_UNRELEASED_STALE',
    ]);
    expect(claimGaps(claims, { 'p.md': 2 })).toEqual([]);
    expect(claimGaps([], { 'p.md': 2 }).map((gap) => gap.code)).toEqual([
      'X_DOC_UNRELEASED_PIN_STALE',
    ]);
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
