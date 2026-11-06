// The tenant proof's report: one line per finding with primitive, leg and where; one coded finding
// each whose fix opens with the command; nothing for a verdict that is not crossed; and never a
// value B was handed, only paths, tables and seeded ids.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from './exercise-report';
import { tenantFindingLines, tenantProofFindings } from './tenant-proof-report';
import { testName } from './test-types';

const HANDED = 'handed-secret-value@example.test';
const base = {
  kind: 'action',
  outcome: 'reached',
  statements: 0,
  effects: [],
  ms: 0,
} as const satisfies Partial<ExerciseRecord>;
const crossed: ExerciseRecord = {
  ...base,
  name: 'readFile',
  tenant: {
    verdict: 'crossed',
    findings: [
      { code: 'X_TENANT_LEAK', leg: 'before', path: 'output.items[0].url' },
      { code: 'X_TENANT_WRITE_CROSSED', leg: 'after', table: 'files', id: 'f-1' },
    ],
  },
};
const proven: ExerciseRecord = { ...base, name: 'readPost', tenant: { verdict: 'proven' } };
const unproven: ExerciseRecord = {
  ...base,
  name: 'boom',
  tenant: { verdict: 'unproven', reason: HANDED },
};

describe(testName('unit', 'tenant proof report'), () => {
  test('one line per finding: primitive, leg, and the path or the table and id', () => {
    expect(tenantFindingLines([proven, crossed, unproven])).toEqual([
      'action readFile · before · X_TENANT_LEAK output.items[0].url',
      'action readFile · after · X_TENANT_WRITE_CROSSED files row f-1',
    ]);
  });

  test('each finding is coded, its fix opening with the one primitive rerun', () => {
    const findings = tenantProofFindings([proven, crossed]);
    expect(findings.map((f) => [f.code, f.at])).toEqual([
      ['X_TENANT_LEAK', 'action readFile'],
      ['X_TENANT_WRITE_CROSSED', 'action readFile'],
    ]);
    for (const finding of findings) expect(finding.fix).toStartWith('x exercise readFile --json');
    expect(findings[0]?.cause).toContain('output.items[0].url');
    expect(findings[1]?.cause).toContain('files row f-1');
  });

  test('a name no shell takes verbatim is a placeholder in the fix, and nothing else is', () => {
    const odd: ExerciseRecord = { ...crossed, name: 'read $(rm -rf)' };
    expect(tenantProofFindings([odd])[0]?.fix).toStartWith('x exercise <primitive> --json');
    expect(tenantProofFindings([proven, unproven])).toEqual([]);
    expect(JSON.stringify(tenantFindingLines([odd, unproven]))).not.toContain(HANDED);
  });
});
