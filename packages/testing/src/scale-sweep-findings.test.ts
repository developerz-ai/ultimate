// A sized seed that could not write a table is ONE finding naming the table, the driver's words and
// every primitive it left unproven — never one bare `unproven` per primitive and no finding at all.

import { describe, expect, test } from 'bun:test';
import { scaleSeedFindings } from './scale-sweep-findings';
import { testName } from './test-types';

const seed = { entity: 'tokens', table: 'tokens', cause: 'duplicate key (code)=(c0)' };
const unproven = {
  verdict: 'unproven',
  reason: 'the sized seed did not write tokens',
  seed,
} as const;

describe(testName('unit', 'scaleSeedFindings'), () => {
  test('one finding per failed table, naming every reader; other unproven proofs add none', () => {
    const findings = scaleSeedFindings([
      { kind: 'query', name: 'listTokens', scale: unproven },
      { kind: 'action', name: 'rotateToken', scale: unproven },
      { kind: 'query', name: 'feed', scale: { verdict: 'flat', expected: [] } },
      { kind: 'query', name: 'odd', scale: { verdict: 'unproven', reason: 'a sized call threw' } },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_EXERCISE_SEED_FAILED');
    expect(findings[0]?.cause).toContain('"tokens"');
    expect(findings[0]?.cause).toContain('duplicate key (code)=(c0)');
    expect(findings[0]?.cause).toContain('query listTokens, action rotateToken');
    expect(findings[0]?.fix).toStartWith('defineExercise({}, { factories: { "tokens": ');
  });
});
