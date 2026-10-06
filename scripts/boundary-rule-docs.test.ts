// The boundary-rule doc rule: `02-boundaries.md`'s stated count and table codes are exactly the
// CLI's `BOUNDARY_CODES`. Fixtures for each drift, then the page itself.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { BOUNDARY_CODES } from '../packages/cli/src/app-boundaries';
import {
  boundaryRuleDocFindings,
  checkBoundaryDoc,
  countOf,
  readBoundaryDoc,
} from './boundary-rule-docs';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree: the repo-scan budget, as every scripts test that does.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const page = (count: string, codes: readonly string[]): string =>
  [
    '# Boundaries',
    '## Generated-app rules — `packages/cli/src/app-boundaries.ts`',
    '',
    `${count}, each with its own code (\`BOUNDARY_CODES\`).`,
    '',
    '| Rule id | Code | Forbids |',
    '|---|---|---|',
    ...codes.map((code) => `| rule | \`${code}\` | a thing |`),
    '',
    '## Next',
    '| x | `X_BOUNDARY_ELSEWHERE` | y |',
  ].join('\n');

const SHIPPED = ['X_BOUNDARY_A', 'X_BOUNDARY_B'];

describe('the boundary-rule table', () => {
  test('reads the count and the codes of its own section only', () => {
    const facts = readBoundaryDoc(page('Two', SHIPPED));
    expect(facts.count).toEqual({ value: 2, line: 4 });
    expect(facts.codes).toEqual(SHIPPED);
    expect(checkBoundaryDoc(facts, SHIPPED)).toEqual([]);
  });

  test('a stale count is the finding, at its line, with the right word in the fix', () => {
    const [finding] = checkBoundaryDoc(readBoundaryDoc(page('Three', SHIPPED)), SHIPPED);
    expect(finding?.code).toBe('X_DOC_BOUNDARY_RULES_STALE');
    expect(finding?.at).toBe('docs/architecture/02-boundaries.md:4');
    expect(finding?.fix).toContain('state two');
  });

  test('a missing, an unshipped and a repeated code are each named', () => {
    const facts = readBoundaryDoc(page('Two', ['X_BOUNDARY_A', 'X_BOUNDARY_Z', 'X_BOUNDARY_A']));
    const [finding] = checkBoundaryDoc({ ...facts, count: { value: 2, line: 4 } }, SHIPPED);
    expect(finding?.cause).toContain('missing: X_BOUNDARY_B');
    expect(finding?.cause).toContain('not shipped: X_BOUNDARY_Z');
    expect(finding?.cause).toContain('repeated: X_BOUNDARY_A');
  });

  test('no section, or no stated count, is a failure, never a pass', () => {
    expect(checkBoundaryDoc(readBoundaryDoc('# nothing'), SHIPPED)[0]?.code).toBe(
      'X_DOC_BOUNDARY_RULES_UNSCANNED',
    );
    expect(countOf('Six')).toBe(6);
    expect(countOf('several')).toBeUndefined();
  });
});

describe('against this repo', () => {
  test('02-boundaries.md states BOUNDARY_CODES exactly', async () => {
    expect(BOUNDARY_CODES.length).toBeGreaterThan(0);
    expect(await boundaryRuleDocFindings(repoRoot())).toEqual([]);
  });
});
