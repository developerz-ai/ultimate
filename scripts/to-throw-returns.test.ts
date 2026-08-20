// The premise is executed here, not asserted from memory: if bun ever fixes `toThrow` to fail on a
// returned Error, the first test below goes red and this whole rule can be deleted.

import { describe, expect, test } from 'bun:test';
import { checkToThrowReturns, errorFactoriesIn, type ThrowGap } from './to-throw-returns';

class Boom extends Error {}

/**
 * The premise, as callables rather than as inline arrows — and the indirection is the honest
 * statement of this rule's reach, not an evasion of it. The scanner reads the INLINE spelling,
 * which is the only one text can be certain about; `expect(returnsAnError).toThrow()` is exactly
 * as broken and needs type information to see. Writing the premise inline would also make this
 * file fail its own gate, which is the correct outcome for the rule and a useless one for the test.
 */
const returnsABoom = (): never => new Boom('x') as unknown as never;
const returnsAnError = (): never => new Error('boom') as unknown as never;
const returnsANumber = (): never => 42 as unknown as never;

describe('the hazard this rule exists for', () => {
  test('sync toThrow PASSES when the callback returns an Error — all three matcher forms', () => {
    // Not a demonstration: these three ARE the defect. A returned error satisfies the class
    // matcher, the bare form and the message form alike. If bun ever fixes this, these go red and
    // the whole rule can be deleted.
    expect(returnsABoom).toThrow(Boom);
    expect(returnsAnError).toThrow();
    expect(returnsAnError).toThrow('boom');
  });

  test('a returned NON-error is correctly reported, which is why the rule reads the value', () => {
    expect(() => {
      expect(returnsANumber).toThrow();
    }).toThrow();
  });

  test('rejects.toThrow is NOT vulnerable — a resolved promise is caught', async () => {
    const asserted = async (): Promise<void> => {
      await expect(Promise.resolve(new Boom('x'))).rejects.toThrow(Boom);
    };
    await expect(asserted()).rejects.toThrow();
  });
});

const gaps = (text: string, factories: readonly string[] = []): readonly ThrowGap[] =>
  checkToThrowReturns({
    tests: [{ path: 'packages/p/src/a.test.ts', text }],
    factories: new Set(factories),
  });

describe('what it reports', () => {
  test('an arrow whose body constructs an error', () => {
    const [gap] = gaps("expect(() => new MailError('x')).toThrow(MailError);");
    expect(gap?.at).toBe('packages/p/src/a.test.ts:1');
    expect(gap?.reason).toContain('constructs an error');
  });

  test('an arrow that calls a function declared to return one', () => {
    const [gap] = gaps('expect(() => sendFailed({ a: 1 })).toThrow();', ['sendFailed']);
    expect(gap?.reason).toContain('sendFailed()');
  });

  test('the reach is the inline arrow only, and the gap is stated rather than assumed away', () => {
    // `expect(returnsAnError).toThrow()` is the same defect and needs type information to see.
    expect(gaps('expect(returnsAnError).toThrow();', ['returnsAnError'])).toEqual([]);
  });
});

describe('what it leaves alone', () => {
  test('a callback that calls something this repo does not declare as returning an error', () => {
    expect(gaps('expect(() => parseThing(raw)).toThrow();')).toEqual([]);
  });

  test('a callback with a statement body — it throws or it does not, and text cannot tell', () => {
    expect(gaps('expect(() => { throw new MailError("x"); }).toThrow();')).toEqual([]);
  });

  test('rejects.toThrow, which the premise test above proves is safe', () => {
    expect(gaps('expect(() => sendFailed(a)).rejects.toThrow();', ['sendFailed'])).toEqual([]);
  });
});

describe('the factory set is derived from source, never listed', () => {
  test('reads a declared error return type in either function form', () => {
    const source = [
      'export function sendFailed(input: X): MailError {',
      'export const routeNotFound = (m: string): HttpError =>',
      'export function plainThing(a: number): string {',
    ].join('\n');
    expect([...errorFactoriesIn(source)].sort()).toEqual(['routeNotFound', 'sendFailed']);
  });
});

describe('the rule does not read its own fixtures', () => {
  test('a bad shape written as a STRING is a fixture, not an assertion this file makes', () => {
    // Every `gaps("expect(() => new MailError(…))…")` above is one of these. Without the
    // exemption this file is its own first finding, which is a rule reporting on the test that
    // proves it works.
    const text = `const fixture = "expect(() => new MailError('x')).toThrow(MailError);";`;
    expect(
      checkToThrowReturns({ tests: [{ path: 'a.test.ts', text }], factories: new Set() }),
    ).toEqual([]);
  });
});
