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

  test('the cause claims no id B chose: an input naming none of A reaches A by an unscoped statement', () => {
    // A primitive whose input carries no id — `{ occurrenceMs }` — still crosses when B's org runs
    // a statement no tenant predicate scopes: the cause must name that reading, not only the id one.
    const [leak, write] = tenantProofFindings([crossed]);
    for (const finding of [leak, write]) {
      expect(finding?.cause).not.toContain("with tenant A's ids");
      expect(finding?.cause).toContain('or by a statement no tenant predicate scopes');
      expect(finding?.fix).toContain('never by the input id alone, nor by an unscoped statement');
    }
    // A write is fixed by writing through the scoped repository, never "read".
    expect(write?.fix).toContain('then write files row f-1 through the repository scoped');
    expect(leak?.fix).toContain('then read the row behind output.items[0].url');
  });

  test('a name no shell takes verbatim is a placeholder in the fix, and nothing else is', () => {
    const odd: ExerciseRecord = { ...crossed, name: 'read $(rm -rf)' };
    expect(tenantProofFindings([odd])[0]?.fix).toStartWith('x exercise <primitive> --json');
    expect(tenantProofFindings([proven, unproven])).toEqual([]);
    expect(JSON.stringify(tenantFindingLines([odd, unproven]))).not.toContain(HANDED);
  });

  test("a tenant: 'none' job's sweep that declared no scope is fixed by crossTenant, never by a scoped repository", () => {
    const sweep: ExerciseRecord = {
      ...base,
      kind: 'job',
      name: 'expireInvites',
      tenant: {
        verdict: 'crossed',
        findings: [{ code: 'X_TENANT_LEAK', leg: 'before', path: 'output.count', sweep: true }],
      },
    };
    const [finding] = tenantProofFindings([sweep]);
    expect(finding?.fix).toStartWith('x exercise expireInvites --json');
    expect(finding?.fix).toContain(
      "crossTenant('<why expireInvites reads every org>', async () => …)",
    );
    expect(finding?.fix).not.toContain('scoped to ctx.actor');
    // The same leak on a job handed one of A's ids (no `sweep`) is B choosing A's row: scoped.
    const chosen: ExerciseRecord = {
      ...sweep,
      tenant: {
        verdict: 'crossed',
        findings: [{ code: 'X_TENANT_LEAK', leg: 'before', path: 'output.count' }],
      },
    };
    expect(tenantProofFindings([chosen])[0]?.fix).toContain('scoped to ctx.actor');
  });

  test('one leaking leg is one finding naming every field, never one per enqueue per field', () => {
    const paths = [0, 1, 2].flatMap((i) =>
      ['orgId', 'userId', 'email'].map((field) => `effect.enqueue[${i}].input.${field}`),
    );
    const noisy: ExerciseRecord = {
      ...base,
      kind: 'job',
      name: 'fanOut',
      tenant: {
        verdict: 'crossed',
        findings: (['before', 'after'] as const).flatMap((leg) =>
          paths.map((path) => ({ code: 'X_TENANT_LEAK' as const, leg, path })),
        ),
      },
    };
    const findings = tenantProofFindings([noisy]);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.cause).toContain(
      'effect.enqueue[*].input.orgId, effect.enqueue[*].input.userId, effect.enqueue[*].input.email (3 each)',
    );
    expect(tenantFindingLines([noisy])).toEqual([
      'job fanOut · before · X_TENANT_LEAK effect.enqueue[*].input.orgId, effect.enqueue[*].input.userId, effect.enqueue[*].input.email (3 each)',
      'job fanOut · after · X_TENANT_LEAK effect.enqueue[*].input.orgId, effect.enqueue[*].input.userId, effect.enqueue[*].input.email (3 each)',
    ]);
  });
});
