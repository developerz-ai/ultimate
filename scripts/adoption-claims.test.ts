// The who-uses-it scan: a claim about production use or adopters outside the generated
// production-apps block is refused. Fixtures only; never an edit to a real page.

import { describe, expect, test } from 'bun:test';
import { adoptionClaimFindings, scanAdoptionClaims, skipAdoptionPath } from './adoption-claims';
import { GENERATED_CLOSE, generatedOpen } from './lib/generated-block';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { PRODUCTION_APPS_FIX } from './production-apps';

const block = (line: string): string =>
  [generatedOpen('production-apps', PRODUCTION_APPS_FIX), line, GENERATED_CLOSE].join('\n');

describe('scanAdoptionClaims', () => {
  test.each([
    'No production use and no outside adopter is claimed.',
    'Ultimate is used in production by several teams.',
    '12 companies use Ultimate today.',
    'Three apps outside this repository build on it.',
    'It has production adopters on three continents.',
    'One of them serves production traffic.',
  ])('a planted claim reds: %s', (claim) => {
    const [finding] = scanAdoptionClaims({ path: 'wiki/Planted.md', text: `# Page\n\n${claim}\n` });
    expect(finding?.code).toBe('X_ADOPTION_CLAIM_UNGENERATED');
    expect(finding?.at).toBe('wiki/Planted.md:3');
    expect(finding?.fix).toContain(PRODUCTION_APPS_FIX);
  });

  test('the same words inside the generated block are the claim, not a copy of it', () => {
    const text = `# Page\n${block('9 apps outside this repository build on Ultimate; serves production traffic.')}\n`;
    expect(scanAdoptionClaims({ path: 'README.md', text })).toEqual([]);
  });

  test('ordinary production prose is not a who-uses-it claim', () => {
    const text = [
      'A deployed boot refuses the development pair in production.',
      'An adopter re-implementing framework code is a framework defect.',
      'Set NODE_ENV=production before the first deploy.',
    ].join('\n');
    expect(scanAdoptionClaims({ path: 'docs/ops/x.md', text })).toEqual([]);
  });
});

describe('the corpus', () => {
  test('records are skipped: their history stands', () => {
    expect(skipAdoptionPath('CHANGELOG.md')).toBe(true);
    expect(skipAdoptionPath('docs/plans/2026/11/09/x.md')).toBe(true);
    expect(skipAdoptionPath('docs/history/x.md')).toBe(true);
    expect(skipAdoptionPath('wiki/FAQ.md')).toBe(false);
  });

  test(
    'this repository states who uses it only through PRODUCTION_APPS',
    async () => {
      expect(await adoptionClaimFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
