// The closure→string crossing, proved by RUNNING the expression the driver builds. A test that
// only asserted on the generated text could not tell a wrapper that catches from one that does not.

import { describe, expect, test } from 'bun:test';
import { stringField } from '@ultimat3/core';
import { runInFakePage } from './e2e-dom-fixture';
import { closureSource, evaluateClosure, evaluateExpression } from './e2e-evaluate';

/**
 * Ambient, so the closures below name them the way a page global is named: `declare const` emits
 * nothing, so the identifier is FREE at run time and is bound by `runInFakePage`'s parameter list —
 * which is exactly how `navigator` reaches a real `page.evaluate`.
 */
declare const onlineState: { readonly onLine: boolean };
declare const appProbe: { read(): number };
declare const laterValue: () => Promise<number>;

const pageOver = (globals: Readonly<Record<string, unknown>> = {}) => ({
  url: () => 'https://app.test/feed',
  evaluate: (expression: string) => runInFakePage(expression, globals),
});

const thrower = {
  read: (): number => {
    throw new TypeError('rows is not iterable');
  },
};

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return String(error);
  }
  return 'nothing was thrown';
};

/** `String(error)` renders the cause alone, and half of what these refusals promise is the fix. */
const fixOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return stringField(error, 'fix') ?? 'the refusal carried no fix';
  }
  return 'nothing was thrown';
};

describe('e2e evaluate — what cannot cross', () => {
  test('a bound function is refused, because toString() answers [native code]', () => {
    const bound = (() => 1).bind(null);
    expect(() => closureSource(bound)).toThrow(/X_E2E_EVALUATE_UNSUPPORTED/);
  });

  test('a native function is refused by the same rule', () => {
    expect(() => closureSource(Object.getOwnPropertyNames as unknown as () => unknown)).toThrow(
      /X_E2E_EVALUATE_UNSUPPORTED/,
    );
  });

  test('a closure declaring a parameter is refused — nothing in the page will pass one', () => {
    const withParameter = (rows: number): number => rows + 1;
    expect(() => closureSource(withParameter as unknown as () => number)).toThrow(
      /X_E2E_EVALUATE_UNSUPPORTED/,
    );
  });

  test('a single UNPARENTHESISED parameter is a parameter too', () => {
    // Built at run time on purpose: Bun's transpiler writes `(rows) => rows` for the TypeScript
    // spelling, so the bracket-free form only exists for a function this process did not compile —
    // which is every function a third-party module hands in.
    const bare = new Function('return rows => rows * 2;')() as () => number;
    expect(bare.toString()).toBe('rows => rows * 2');
    expect(() => closureSource(bare)).toThrow(/X_E2E_EVALUATE_UNSUPPORTED/);
  });

  test('a method shorthand is refused: its source is not a standalone expression', () => {
    const holder = {
      probe(): number {
        return 1;
      },
    };
    expect(holder.probe.toString().startsWith('probe(')).toBe(true);
    expect(() => closureSource(holder.probe)).toThrow(/X_E2E_EVALUATE_UNSUPPORTED/);
  });

  test('a native function is refused AS native, not as a parse failure', () => {
    // `[native code]` is also a syntax error, so the parse rule below would refuse it too — with
    // "does not stringify to an expression", which sends the reader looking for a typo in their
    // own closure. The reason is the instruction, so it is the reason this asserts.
    let message = '';
    try {
      closureSource(Object.getOwnPropertyNames as unknown as () => unknown);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('no source to send');
  });

  test('a bound function is refused as native too, for the same reason', () => {
    let message = '';
    try {
      closureSource((() => 1).bind(null));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('no source to send');
  });

  test('a zero-parameter arrow is accepted', () => {
    expect(closureSource(() => 1)).toBe('() => 1');
  });
});

describe('e2e evaluate — a captured binding', () => {
  test('reaches the page as a free name and comes back as X_E2E_EVALUATE_CAPTURED', async () => {
    // An OBJECT and not a number: Bun folds `wanted === 3` to `!0` before `toString()` ever runs,
    // so a captured primitive can vanish from the source entirely. A captured reference cannot.
    const wanted = { rows: 3 };
    const promise = evaluateClosure(pageOver(), () => wanted.rows === 3);
    await expect(promise).rejects.toThrow(/X_E2E_EVALUATE_CAPTURED/);
  });

  test('the refusal names the binding, which is the whole point of catching it', async () => {
    const wanted = { rows: 3 };
    // The FIX line, not the cause: the cause renders the closure's own source, so `wanted` appears
    // in it whatever the driver worked out — an assertion there passes over a refusal that named
    // nothing. The fix carries the binding and nothing else.
    expect(await fixOf(() => evaluateClosure(pageOver(), () => wanted.rows === 3))).toContain(
      'named "wanted"',
    );
  });

  test('a capture is NOT reported when the page happens to have a binding of that name', async () => {
    const wanted = { rows: 3 };
    const page = pageOver({ wanted: { rows: 3 } });
    expect(await evaluateClosure(page, () => wanted.rows === 3)).toBe(true);
  });
});

describe('e2e evaluate — a page that throws', () => {
  test('an app throw is X_E2E_EVALUATE_THREW, never a driver fault', async () => {
    const promise = evaluateClosure(pageOver({ appProbe: thrower }), () => appProbe.read());
    await expect(promise).rejects.toThrow(/X_E2E_EVALUATE_THREW/);
  });

  test('the thrown name and message survive the crossing', async () => {
    const message = await messageOf(() =>
      evaluateClosure(pageOver({ appProbe: thrower }), () => appProbe.read()),
    );
    expect(message).toContain('TypeError');
    expect(message).toContain('rows is not iterable');
  });
});

describe('e2e evaluate — what does cross', () => {
  test('a closure naming only page globals answers its value', async () => {
    const page = pageOver({ onlineState: { onLine: false } });
    expect(await evaluateClosure(page, () => onlineState.onLine)).toBe(false);
  });

  test('an async closure is awaited in the page rather than answered as a promise', async () => {
    const page = pageOver({ laterValue: () => Promise.resolve(7) });
    expect(await evaluateClosure(page, () => laterValue())).toBe(7);
  });

  test('undefined survives as undefined and not as a parse failure', async () => {
    expect(await evaluateClosure(pageOver(), () => undefined)).toBeUndefined();
  });

  test('the wrapper never lets a throw cross the wire — the page always answers a value', async () => {
    const raw = await runInFakePage(evaluateExpression('() => { throw new RangeError("nope"); }'));
    expect(JSON.parse(String(raw))).toMatchObject({ ok: false, name: 'RangeError' });
  });
});
