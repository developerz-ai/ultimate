// The floor under every refusal in the framework: a value the app controls becomes text without
// throwing, and without growing without bound. Each case below is a value that has already
// destroyed an error somewhere in this repo, or one measured to.

import { describe, expect, test } from 'bun:test';
import {
  describeValue,
  isThrownError,
  MAX_RENDERED_LENGTH,
  renderCauseValue,
  renderFixLiteral,
  renderMetaRecord,
  renderThrowable,
  stringField,
} from './error-render';

/** Every value that has destroyed a refusal in this repo, plus the two that only threaten to. */
const hostile = (): ReadonlyMap<string, unknown> => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  return new Map<string, unknown>([
    ['a bigint', 10n],
    ['a symbol', Symbol('post')],
    ['a cycle', cyclic],
    [
      'a hostile toJSON',
      {
        toJSON: () => {
          throw new Error('gotcha');
        },
      },
    ],
    [
      'a throwing getter',
      Object.defineProperty({}, 'id', {
        enumerable: true,
        get: () => {
          throw new Error('gotcha');
        },
      }),
    ],
    [
      'a throwing proxy',
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('gotcha');
          },
        },
      ),
    ],
  ]);
};

describe('renderCauseValue', () => {
  for (const [label, value] of hostile()) {
    test(`renders ${label} instead of throwing`, () => {
      let rendered = '';
      expect(() => {
        rendered = renderCauseValue(value);
      }).not.toThrow();
      expect(rendered).not.toBe('');
    });
  }

  test('the raw forms it replaces really do throw', () => {
    // Without this the suite above proves only that the helper runs, not that it was needed.
    // The symbol is read back out of `hostile()`, so it arrives as `unknown` — the type a cause
    // actually has at the call sites this helper replaced. That is also the record of why the bug
    // shipped three times: the compiler permits `${value}` for an `unknown`, and refuses it only
    // when the static type is `symbol`, which it never is where a cause is built.
    const symbol = hostile().get('a symbol');
    expect(() => JSON.stringify(10n)).toThrow();
    expect(() => `${symbol}`).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow();
  });

  test('keeps the value readable when it can be read', () => {
    expect(renderCauseValue('abc')).toBe('"abc"');
    expect(renderCauseValue(7)).toBe('7');
    expect(renderCauseValue(null)).toBe('null');
    expect(renderCauseValue({ a: 1 })).toBe('{"a":1}');
    expect(renderCauseValue([1, 'b'])).toBe('[1,"b"]');
  });

  test('bounds a hostile primitive: the cause is text a log line can hold', () => {
    const rendered = renderCauseValue('x'.repeat(5_000_000));

    expect(rendered.length).toBeLessThanOrEqual(MAX_RENDERED_LENGTH);
    expect(rendered).toStartWith('"xxx');
    expect(rendered).toEndWith('…');
  });

  test('bounds a nested payload the same way, entry by entry', () => {
    // Wide AND deep AND long, so a bound on any one of the three alone would still let it through.
    const wide = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`k${i}`, 'y'.repeat(1_000)]),
    );
    const rendered = renderCauseValue({ body: wide, deep: { a: { b: { c: wide } } } });

    expect(rendered.length).toBeLessThanOrEqual(MAX_RENDERED_LENGTH);
    expect(rendered).not.toBe('');
  });

  test('leaves a cause short enough to read exactly as it was', () => {
    // The bound may not cost the messages the framework actually writes: only the ones nobody reads.
    const readable = { table: 'posts', column: 'publish_at', given: 'not-a-date' };
    expect(renderCauseValue(readable)).toBe(JSON.stringify(readable));
  });

  test('degrades to a type name, never to a value it cannot bound', () => {
    expect(renderCauseValue(undefined)).toBe('undefined');
    expect(renderCauseValue(10n)).toBe('10n');
    expect(renderCauseValue(Symbol('post'))).toBe('Symbol(post)');
    // A function stringifies to `undefined`, and printing its source would be unbounded.
    expect(renderCauseValue(() => 1)).toBe('a function');
    expect(
      renderCauseValue({
        toJSON: () => {
          throw new Error('gotcha');
        },
      }),
      // `a object`, not `an object`: the exact text `@ultimat3/entity` and `@ultimat3/flags`
      // already ship, so adopting this helper changes no message anywhere.
    ).toBe('a object that cannot be rendered');
  });
});

describe('renderMetaRecord', () => {
  test('renders a function instead of copying it, because a copied toJSON runs later', () => {
    // `JSON.stringify(fn)` answers `undefined` rather than throwing, so a function passed the
    // renderability probe and was copied through — and a `meta.toJSON` is then INVOKED when
    // `--json` serialises the error around it. The throw moved one layer out; it did not go.
    const meta = renderMetaRecord({
      toJSON: () => {
        throw new Error('gotcha');
      },
      id: 'post-1',
    });

    expect(() => JSON.stringify({ code: 'X_ID_INVALID', meta })).not.toThrow();
    expect(meta?.['toJSON']).toBe('a function');
    // One broken value may not cost the reader the keys beside it.
    expect(meta?.['id']).toBe('post-1');
  });

  test('a record that serialises is handed back whole, identity included', () => {
    const meta = { given: 'not-a-uuid', table: 'posts' };
    expect(renderMetaRecord(meta)).toBe(meta);
  });
});

describe('renderThrowable', () => {
  test('an Error keeps its own words, so the cause names what actually happened', () => {
    expect(renderThrowable(new TypeError('nope'))).toBe('TypeError: nope');
  });

  test('a message getter that throws does not take the report with it', () => {
    const hostileMessage = Object.defineProperty(new Error('unused'), 'message', {
      get: () => {
        throw new Error('gotcha');
      },
    });

    expect(renderThrowable(hostileMessage)).not.toBe('');
  });

  test('a proxy whose getPrototypeOf trap throws is still rendered', () => {
    // `instanceof` runs the trap, so the TEST for an Error is itself a throw the catch cannot pay.
    const trapped = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('gotcha');
        },
      },
    );

    expect(isThrownError(trapped)).toBe(false);
    expect(renderThrowable(trapped)).toBe('{}');
  });

  test('anything that is not an Error goes through renderCauseValue', () => {
    for (const value of hostile().values()) {
      expect(renderThrowable(value)).not.toBe('');
    }
    expect(renderThrowable('boom')).toBe('"boom"');
    expect(renderThrowable(undefined)).toBe('undefined');
  });

  test('the raw form it replaces really does throw', () => {
    const trapped = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('gotcha');
        },
      },
    );
    expect(() => trapped instanceof Error).toThrow();
  });
});

describe('stringField', () => {
  test('reads the field an error crossing a boundary arrived with', () => {
    expect(stringField({ code: 'X_DB_DRIFT' }, 'code')).toBe('X_DB_DRIFT');
  });

  test('a field that is not a string is the same answer as a field that is absent', () => {
    // Both mean "this value did not supply the field", and a caller that told them apart would
    // have to decide what a numeric `code` means — a question no surface has an answer for.
    expect(stringField({ code: 7 }, 'code')).toBeUndefined();
    expect(stringField({}, 'code')).toBeUndefined();
    expect(stringField(null, 'code')).toBeUndefined();
    expect(stringField('X_DB_DRIFT', 'code')).toBeUndefined();
  });

  test('a getter that throws is a missing field, not a lost report', () => {
    // The read that broke this: `typeof shape?.code === 'string'` is a getter CALL, and it ran
    // one line before the total renderer that was supposed to make the path safe.
    const trapped = Object.defineProperty({}, 'code', {
      get: () => {
        throw new Error('gotcha');
      },
      enumerable: true,
    });

    expect(stringField(trapped, 'code')).toBeUndefined();
  });

  test('a proxy that traps every read is a missing field too', () => {
    const trapped = new Proxy(
      {},
      {
        get: () => {
          throw new Error('gotcha');
        },
      },
    );

    expect(stringField(trapped, 'cause')).toBeUndefined();
  });
});

describe('renderFixLiteral', () => {
  test('quotes a string so the fix line parses', () => {
    expect(renderFixLiteral('post', "'<kind>'")).toBe('"post"');
    expect(renderFixLiteral("it's", "'<kind>'")).toBe('"it\'s"');
  });

  test('substitutes the placeholder for anything that is not a string', () => {
    // A degraded type name in a `fix:` would produce a command that does not run — the reason
    // this is a second function rather than a second call to `renderCauseValue`.
    for (const value of hostile().values()) {
      expect(renderFixLiteral(value, "'<kind>'")).toBe("'<kind>'");
    }
    expect(renderFixLiteral(undefined, '<org>')).toBe('<org>');
    expect(renderFixLiteral(7, '<org>')).toBe('<org>');
  });
});

describe('describeValue', () => {
  test('leaks no rejected content — not the value, not a substring of it', () => {
    for (const secret of ['hunter2', 'sk-live-4f9c', '4111111111111111', 'a@b.com']) {
      const rendered = describeValue(secret);
      expect(rendered).not.toContain(secret);
      for (let cut = 3; cut < secret.length; cut += 1) {
        expect(rendered).not.toContain(secret.slice(0, cut));
      }
    }
  });

  test('leaks nothing from inside an object or an array either', () => {
    expect(describeValue({ password: 'hunter2' })).toBe('an object');
    expect(describeValue(['hunter2', 'x'])).toBe('an array of 2 items');
  });

  test('reports the shape, which is what a format violation needs', () => {
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(null)).toBe('null');
    expect(describeValue('')).toBe('an empty string');
    expect(describeValue('a')).toBe('a string of 1 character');
    expect(describeValue('hunter2')).toBe('a string of 7 characters');
    expect(describeValue(1)).toBe('a number');
    expect(describeValue(Number.NaN)).toBe('NaN');
    expect(describeValue(true)).toBe('a boolean');
    expect(describeValue(new Date(Number.NaN))).toBe('an invalid Date');
  });
});
