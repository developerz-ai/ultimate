// The gate-step rule, over fixtures rather than over the tree: a page three other agents are
// rewriting is not a place to assert a negative case from.

import { describe, expect, test } from 'bun:test';
import { checkGateSteps, gateStepFinding, skipStepPath } from './gate-steps';

const STEPS = ['typecheck', 'lint', 'contract', 'contract-diff', 'seo', 'i18n', 'roadmap'];
const page = (text: string) => ({ path: 'wiki/Fixture.md', text });

/**
 * Every case carries a CONTROL page that states the count correctly, because a corpus stating
 * nothing at all is itself a finding — `vacuous` — and a negative case must fail for the reason it
 * names rather than for reading an empty corpus.
 */
const CONTROL = { path: 'wiki/Control.md', text: '`x verify` runs 7 steps.' };
const gaps = (text: string) => checkGateSteps({ pages: [page(text), CONTROL], steps: STEPS });

describe('the count rule', () => {
  test('accepts the number this build runs', () => {
    expect(gaps('`x verify` runs 7 steps.')).toEqual([]);
  });

  test('reports a stale total and names the number it should hold', () => {
    const [gap] = gaps('the gate — 17 steps, in this order');
    if (gap === undefined) return expect.unreachable('a stale total must be reported');
    expect(gap.kind).toBe('count');
    expect(gap.detail).toContain('7');
    expect(gateStepFinding(gap, STEPS).fix).toContain('to 7');
  });

  test('reads the word form, because a page spells it out', () => {
    expect(gaps('`x verify`. Seventeen steps, in this order:')[0]?.kind).toBe('count');
  });

  test("reads the total out of the gate's own summary line, with no other context", () => {
    expect(gaps('✓ 14 of 17 steps passed in 11153ms')[0]?.kind).toBe('count');
  });

  test('refuses a passed count above the total', () => {
    const [gap] = gaps('✓ 9 of 7 steps passed');
    expect(gap?.kind).toBe('passed');
  });

  test('leaves a step count that is not the gate alone', () => {
    // `packages/jobs/CLAUDE.md` writes "20,000 steps" about a backfill's pages.
    expect(gaps('a backfill over a million rows — 20000 steps, ~200M compares')).toEqual([]);
  });

  test('leaves a SUBSET count alone — a pin is not the total', () => {
    expect(gaps('`x verify` — pinned red on 4 steps in gated-apps.ts')).toEqual([]);
  });

  test('leaves an older release naming its own count alone', () => {
    expect(gaps('`x verify`: 1.0.0 shipped 17 steps')).toEqual([]);
  });
});

describe('the list rule', () => {
  const full = STEPS.join(', ');

  test('accepts the list in the order the gate runs it', () => {
    expect(gaps(`the gate — 7 steps: ${full}`)).toEqual([]);
  });

  test('reports an enumeration that omits an inserted step, and names it', () => {
    const [gap] = gaps('the gate — 7 steps: typecheck, lint, contract, contract-diff, roadmap');
    expect(gap?.kind).toBe('list');
    expect(gap?.detail).toBe('omits seo, i18n');
  });

  test('does not read a SUBSET of the steps as the whole list', () => {
    // The six test types name several steps and neither anchor.
    expect(gaps('the six test types: contract, live, job, e2e, eval')).toEqual([]);
  });

  test('a step name inside a longer word is not a citation', () => {
    // `wiki/FAQ.md` sits `lives` before `typecheck` in the same sentence as the list. Reading it as
    // `live` reported the one correct enumeration in the tree as mis-ordered.
    expect(gaps(`a check that lives only in CI. 7 steps: ${full}`)).toEqual([]);
  });

  test('`contract` inside `contract-diff` is not a second citation', () => {
    expect(gaps(`7 steps: ${full}`)).toEqual([]);
  });
});

describe('the vacuous guard', () => {
  test('a corpus stating nothing is a finding, not a green', () => {
    const [gap] = checkGateSteps({ pages: [page('nothing to see')], steps: STEPS });
    if (gap === undefined) return expect.unreachable('an empty corpus must be reported');
    expect(gap.kind).toBe('vacuous');
    expect(gateStepFinding(gap, STEPS).code).toBe('X_DOC_GATE_STEPS_UNSCANNED');
  });
});

describe('what is history and not a claim', () => {
  test.each(['docs/plans/2026/08/12/x.md', 'CHANGELOG.md'])('skips %s', (path) => {
    expect(skipStepPath(path)).toBe(true);
  });

  test('reads a wiki page', () => {
    expect(skipStepPath('wiki/CLI-Reference.md')).toBe(false);
  });
});
