// `workflow-if.ts`: the `if:` subset ci.yml writes, read the way GitHub reads it for one event — and
// undefined, never a guess, for anything outside it.

import { describe, expect, test } from 'bun:test';
import { expr } from './ci-workflow-read';
import { evaluateIf } from './workflow-if';

const PUSH_MAIN = { 'github.event_name': 'push', 'github.ref': 'refs/heads/main' };
const PULL = { 'github.event_name': 'pull_request', 'github.ref': 'refs/pull/7/merge' };

describe('unit · workflow-if', () => {
  test('equality, disjunction and the precedence of && over ||', () => {
    const proof =
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'pull_request'";
    expect(evaluateIf(proof, PUSH_MAIN)).toBe(true);
    expect(evaluateIf(proof, PULL)).toBe(true);
    expect(evaluateIf(proof, { ...PUSH_MAIN, 'github.ref': 'refs/heads/next' })).toBe(false);
    expect(
      evaluateIf(
        "github.event_name == 'push' || github.event_name == 'pull_request' && false",
        PUSH_MAIN,
      ),
    ).toBe(true);
  });

  // The shape a substring test let through: it names `pull_request` and still skips every one.
  test('a main-ref guard around the pull_request arm is false on a pull request', () => {
    const narrowed =
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'pull_request')";
    expect(evaluateIf(narrowed, PUSH_MAIN)).toBe(true);
    expect(evaluateIf(narrowed, PULL)).toBe(false);
  });

  test('an unset output is empty, status functions answer a healthy run, an expression is unwrapped', () => {
    const gated = expr("!cancelled() && needs.tested.outputs.tested != 'true'");
    expect(evaluateIf(gated, PULL)).toBe(true);
    expect(evaluateIf(gated, { ...PULL, 'needs.tested.outputs.tested': 'true' })).toBe(false);
    expect(evaluateIf('', PULL)).toBe(true);
  });

  test('outside the subset is undefined: a function it does not know, a bad parenthesis, a stray token', () => {
    expect(evaluateIf("contains(github.ref, 'main')", PULL)).toBeUndefined();
    expect(evaluateIf("(github.event_name == 'push'", PULL)).toBeUndefined();
    expect(evaluateIf("github.event_name == 'push' )", PULL)).toBeUndefined();
    expect(evaluateIf('github.event_name >= 1', PULL)).toBeUndefined();
  });
});
