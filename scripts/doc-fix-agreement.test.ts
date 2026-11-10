// The Error-Codes page's Fix cells against the fix the throw sites register: a row naming nothing
// its code's sites name is a disagreement; wording, backticks and placeholders are not.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  agreementFindings,
  checkFixAgreement,
  DISAGREEMENT_PIN,
  docFixAgreementFindings,
  fixAnchors,
} from './doc-fix-agreement';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// The last case scans every package's throw sites.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const page = (fix: string): string =>
  [
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    `| \`X_FIXTURE_CODE\` | a fixture | a fixture cause | ${fix} |`,
  ].join('\n');

const sites = new Map([
  [
    'X_FIXTURE_CODE',
    [{ fix: "list the action's module in defineApi({ actions }) in apps/<value>/api/index.ts" }],
  ],
]);

describe('fixAnchors', () => {
  test('commands, calls, files and env names; never prose or the placeholder spelling', () => {
    const anchors = fixAnchors(
      'run `bun run verify`, then defineApi({ x }) in apps/<app>/api/index.ts with DATABASE_URL set (after: null)',
    );
    expect([...anchors].sort()).toEqual([
      'DATABASE_URL',
      'bun run verify',
      'defineApi()',
      'index.ts',
    ]);
  });
});

describe('checkFixAgreement', () => {
  test('the same fix in other words agrees', () => {
    const doc = page('list the module in `defineApi({ actions })` — `apps/<app>/api/index.ts`');
    expect(checkFixAgreement(doc, sites)).toEqual([]);
  });

  test('a planted disagreement — a fix naming another call — is reported at its line', () => {
    const [gap] = checkFixAgreement(
      page('call `registerAction(action)` before projecting it'),
      sites,
    );
    expect(gap?.code).toBe('X_FIXTURE_CODE');
    expect(gap?.line).toBe(3);
    expect(gap?.doc).toEqual(['registerAction()']);
  });

  test('a row or a site with nothing to compare is no verdict either way', () => {
    expect(checkFixAgreement(page('fix the failure named in the cause'), sites)).toEqual([]);
    expect(checkFixAgreement(page('`registerAction(a)`'), new Map())).toEqual([]);
  });
});

describe('agreementFindings', () => {
  const gap = { code: 'X_FIXTURE_CODE', line: 3, doc: ['a()'], source: ['b()'] };

  test('above the pin, every disagreement is listed', () => {
    const over = Array.from({ length: DISAGREEMENT_PIN + 1 }, () => gap);
    const findings = agreementFindings(over);
    expect(findings).toHaveLength(DISAGREEMENT_PIN + 1);
    expect(findings[0]?.code).toBe('X_DOC_FIX_DISAGREES');
  });

  test('below the pin, the pin itself is stale', () => {
    const [finding] = agreementFindings([]);
    expect(finding?.code).toBe('X_DOC_FIX_DISAGREES_PIN_STALE');
  });
});

describe('this repository', () => {
  test('disagreements sit exactly at the pin: more is new drift, fewer is a stale pin', async () => {
    const findings = await docFixAgreementFindings(repoRoot());
    expect(findings).toEqual([]);
    expect(DISAGREEMENT_PIN).toBeGreaterThan(0);
  });
});
