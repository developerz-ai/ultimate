import { describe, expect, test } from 'bun:test';
import { floorProblemFindings, parseVerifyFloor } from './verify-floor';
import { leftOutOfCi, readLocalOnly } from './verify-local-only';

const declared = ['lint', 'e2e'];

describe('readLocalOnly', () => {
  test('absent is none', () => {
    expect(readLocalOnly({ steps: [] }, declared)).toEqual({ problems: [] });
  });

  test('a step with a why is read, trimmed', () => {
    expect(readLocalOnly({ localOnly: { e2e: ' browser ' } }, declared)).toEqual({
      localOnly: { e2e: 'browser' },
      problems: [],
    });
  });

  test('refuses a non-object, an unknown step and a blank why', () => {
    expect(readLocalOnly({ localOnly: [] }, declared).problems).toHaveLength(1);
    expect(readLocalOnly({ localOnly: { nope: 'x' } }, declared).problems[0]).toContain('"nope"');
    // A step name is quoted as JSON, so a newline in it cannot split the finding's one line.
    expect(readLocalOnly({ localOnly: { 'a\nb': 'x' } }, declared).problems[0]).toContain(
      '"a\\nb"',
    );
    expect(readLocalOnly({ localOnly: { e2e: ' ' } }, declared).problems[0]).toContain(
      'no written why',
    );
  });
});

describe('readLocalOnly with a floored step', () => {
  test('a step the floor lists may be local-only: it is floored where it runs', () => {
    expect(readLocalOnly({ steps: ['e2e'], localOnly: { e2e: 'x' } }, declared)).toEqual({
      localOnly: { e2e: 'x' },
      problems: [],
    });
  });
});

describe('leftOutOfCi', () => {
  const localOnly = { e2e: 'browser' };
  test('only in CI, and never when --only names the step', () => {
    expect(leftOutOfCi(localOnly, 'e2e', true, undefined)).toBe(true);
    expect(leftOutOfCi(localOnly, 'e2e', false, undefined)).toBe(false);
    expect(leftOutOfCi(localOnly, 'e2e', true, ['e2e'])).toBe(false);
    expect(leftOutOfCi(localOnly, 'lint', true, undefined)).toBe(false);
    expect(leftOutOfCi(undefined, 'e2e', true, undefined)).toBe(false);
  });
});

describe('a bad localOnly entry, as a finding', () => {
  test('its fix is a localOnly edit, not the steps example', () => {
    const floor = parseVerifyFloor(JSON.stringify({ steps: [], localOnly: { e2e: ' ' } }));
    const [finding] = floorProblemFindings(floor);
    expect(finding?.fix).toContain('"localOnly"');
    expect(finding?.fix).not.toContain('{"steps"');
  });
});
