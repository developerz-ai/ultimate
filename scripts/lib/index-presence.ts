// Single responsibility: the presence proofs `index-of-order.ts` reads OUT OF ASSERTIONS a test
// already makes, beyond an explicit `>= 0` — an order against another index, and a value read at
// the index. Each is sound: it holds only when the index cannot be the phantom `-1`.

import { balancedClose, topLevelArguments } from './balanced-paren';
import { boundIndexInitialiser } from './index-operand';

const normalised = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** One `expect(subject)[.not].matcher(argument)` in a test body, whitespace-normalised. */
export interface Assertion {
  readonly subject: string;
  readonly negated: boolean;
  readonly matcher: string;
  readonly argument: string;
}

/**
 * Every assertion in `body`. The SUBJECT is `expect`'s first argument only, so
 * `expect(at, 'binaryArgs does not pass …')` — a failure message riding along — is about `at`.
 */
export function assertionsIn(body: string): readonly Assertion[] {
  const out: Assertion[] = [];
  for (const m of body.matchAll(/\bexpect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = balancedClose(body, open);
    if (close < 0) continue;
    const call = /^\s*\.\s*(not\s*\.\s*)?([A-Za-z]+)\s*\(/.exec(body.slice(close + 1));
    if (call === null) continue;
    const argOpen = close + call[0].length;
    const argClose = balancedClose(body, argOpen);
    if (argClose < 0) continue;
    out.push({
      subject: normalised(topLevelArguments(body.slice(open + 1, close))[0] ?? ''),
      negated: call[1] !== undefined,
      matcher: call[2] as string,
      argument: normalised(topLevelArguments(body.slice(argOpen + 1, argClose))[0] ?? ''),
    });
  }
  return out;
}

const FROM_INDEX = /\b(?:indexOf|findIndex)\s*\(/;

/** An index, written out or bound to a name in this body — so a value that is always >= -1. */
const isIndex = (body: string, text: string): boolean =>
  FROM_INDEX.test(text) || boundIndexInitialiser(body, text) !== undefined;

/**
 * `expect(x).toBeGreaterThan(<an index>)`, or `expect(<an index>).toBeLessThan(x)`: every index is
 * `>= -1`, so `x` is `>= 0`. STRICT only — `x >= -1` is exactly the phantom. Read in
 * `packages/db/src/migrate.test.ts`, which orders `COMMIT` after an `index` it proved this way.
 */
export function provenByOrder(body: string, assertions: readonly Assertion[], x: string): boolean {
  return assertions.some(
    (one) =>
      !one.negated &&
      ((one.matcher === 'toBeGreaterThan' && one.subject === x && isIndex(body, one.argument)) ||
        (one.matcher === 'toBeLessThan' && one.argument === x && isIndex(body, one.subject))),
  );
}

/** Matchers a value read at `haystack[-1]` — `undefined` — fails, given a defined expectation. */
const VALUE_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toContain',
  'toStartWith',
  'toEndWith',
]);

/**
 * `expect(on[pin]?.params).toEqual({ … })` on the SAME haystack the index was taken from:
 * `on[-1]` is `undefined`, so the assertion fails on a phantom index. Read in
 * `packages/testing/src/cdp-e2e-session.test.ts`. Not against `undefined`, and never negated.
 */
export function provenByValueAt(
  assertions: readonly Assertion[],
  receiver: string,
  x: string,
): boolean {
  const at = `${receiver}[${x}]`;
  return assertions.some(
    (one) =>
      !one.negated &&
      VALUE_MATCHERS.has(one.matcher) &&
      one.argument !== 'undefined' &&
      one.argument !== '' &&
      (one.subject === at || /^[.?[]/.test(one.subject.slice(at.length))) &&
      one.subject.startsWith(at),
  );
}
