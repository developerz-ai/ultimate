import { describe, expect, test } from 'bun:test';
import { renderCauseValue, renderFixLiteral } from './error-render';

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
    expect(() => JSON.stringify(10n)).toThrow();
    expect(() => `${Symbol('post')}`).toThrow();
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
