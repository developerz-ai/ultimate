import { describe, expect, test } from 'bun:test';
import { IslandPropsInvalidError } from './errors';
import { checkIslandProps, ISLAND_PROPS_MAX_BYTES } from './island-props';
import type { JsxProps } from './jsx';

const FILE = 'app/posts/page.tsx';
const MODULE = './cart.island.tsx';

const check = (props: JsxProps, declared: readonly string[]): Record<string, unknown> =>
  checkIslandProps(props, declared, FILE, MODULE) as Record<string, unknown>;

describe('checkIslandProps', () => {
  test('keeps declared JSON props verbatim', () => {
    const bag = check({ id: 'p1', count: 2, tags: ['a'], nested: { ok: true } }, [
      'id',
      'count',
      'tags',
      'nested',
    ]);
    expect(bag).toEqual({ id: 'p1', count: 2, tags: ['a'], nested: { ok: true } });
  });

  test('refuses an undeclared prop by name', () => {
    expect(() => check({ passwordHash: 'x' }, ['id'])).toThrow(IslandPropsInvalidError);
  });

  test('refuses a value JSON cannot carry', () => {
    expect(() => check({ at: new Date(0) }, ['at'])).toThrow(IslandPropsInvalidError);
  });

  test('refuses a cycle', () => {
    const row: Record<string, unknown> = { id: 'p1' };
    row['self'] = row;
    expect(() => check({ row }, ['row'])).toThrow(IslandPropsInvalidError);
  });

  test('refuses props over the byte cap', () => {
    const big = 'x'.repeat(ISLAND_PROPS_MAX_BYTES + 1);
    expect(() => check({ id: big }, ['id'])).toThrow(IslandPropsInvalidError);
  });
});

// `JSON.parse` creates a real OWN `__proto__` key, so a request body is enough to reach this —
// which is what makes it the shape the structural walk exists to stop, not a curiosity.
describe('a prop named __proto__', () => {
  const parsed = (): Record<string, unknown> =>
    JSON.parse('{"name":"ok","__proto__":{"admin":true},"tail":1}') as Record<string, unknown>;

  test('travels to the browser instead of being dropped', () => {
    const bag = check({ row: parsed() }, ['row']);
    const row = bag['row'] as Record<string, unknown>;
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(bag))).toEqual({
      row: { name: 'ok', __proto__: { admin: true }, tail: 1 },
    });
  });

  test('never becomes the returned record’s prototype', () => {
    const bag = check({ row: parsed() }, ['row']);
    const row = bag['row'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    // The server reads this bag too: a foreign prototype answers `admin` for a row that has none.
    expect((row as { admin?: unknown }).admin).toBeUndefined();
  });

  test('is counted against the byte cap, since a dropped key weighs nothing', () => {
    const payload = JSON.parse(
      `{"__proto__":{"blob":"${'x'.repeat(ISLAND_PROPS_MAX_BYTES + 1)}"}}`,
    ) as Record<string, unknown>;
    expect(() => check({ row: payload }, ['row'])).toThrow(IslandPropsInvalidError);
  });

  test('is walked like any other key, so an unserializable value under it is refused', () => {
    const payload = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    // Reached through `Object.values`, not `payload['__proto__']`: the accessor is what the walk
    // must not use either, and biome refuses it in this file for the same reason.
    const [nested] = Object.values(payload) as Record<string, unknown>[];
    if (nested !== undefined) nested['at'] = new Date(0);
    expect(() => check({ row: payload }, ['row'])).toThrow(IslandPropsInvalidError);
  });

  test('at the top level lands on the bag as an own key, not as its prototype', () => {
    const props = JSON.parse('{"__proto__":{"admin":true}}') as JsxProps;
    const bag = check(props, ['__proto__']);
    expect(Object.hasOwn(bag, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype);
    expect((bag as { admin?: unknown }).admin).toBeUndefined();
  });
});

/**
 * `[object Object]` is not an instruction. The refusal names the value the way an author can act
 * on it, so the message is the difference between "something is wrong" and "props.at is a Date".
 */
describe('the refusal names the value, not its stringification', () => {
  const causeOf = (props: JsxProps, declared: readonly string[]): string => {
    try {
      check(props, declared);
    } catch (error) {
      return error instanceof IslandPropsInvalidError
        ? error.cause
        : `wrong error: ${String(error)}`;
    }
    return 'did-not-throw';
  };

  test.each<[string, unknown, string]>([
    ['a Date', new Date(0), 'props.value is a Date'],
    ['a Map', new Map([['a', 1]]), 'props.value is a Map'],
    ['a Set', new Set([1]), 'props.value is a Set'],
    ['NaN', Number.NaN, 'props.value is NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'props.value is Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'props.value is -Infinity'],
    ['a function', () => 1, 'props.value is a function'],
    ['a bigint', 1n, 'props.value is a bigint'],
    ['a symbol', Symbol('s'), 'props.value is a symbol'],
    ['undefined', undefined, 'props.value is undefined'],
  ])('%s', (_name, value, expected) => {
    expect(causeOf({ value } as JsxProps, ['value'])).toContain(expected);
  });

  test('a class instance is named by its class, which is the row an author recognises', () => {
    class PostRow {
      readonly id = 'p1';
    }
    expect(causeOf({ value: new PostRow() } as JsxProps, ['value'])).toContain(
      'props.value is an instance of PostRow',
    );
    // A boxed primitive is an instance too — `new String('x')` is not the string it prints as.
    expect(causeOf({ value: new String('x') } as JsxProps, ['value'])).toContain(
      'props.value is an instance of String',
    );
  });

  test('an object with no reachable constructor still gets a noun, never [object Object]', () => {
    // Prototype chain: value → (a null-prototype object) → null. Not a plain object, and
    // `value.constructor` resolves to nothing, so the fallback noun is what an author reads.
    const orphan: unknown = Object.create(Object.create(null) as object);
    const cause = causeOf({ value: orphan } as JsxProps, ['value']);
    expect(cause).toContain('props.value is an instance of a class');
    expect(cause).not.toContain('[object Object]');
  });

  test('the path is the path into the bag, so a nested offender is found without a search', () => {
    expect(causeOf({ row: { meta: { at: new Date(0) } } } as JsxProps, ['row'])).toContain(
      'props.row.meta.at is a Date',
    );
    expect(causeOf({ row: [{ at: new Date(0) }] } as JsxProps, ['row'])).toContain(
      'props.row[0].at is a Date',
    );
  });

  test('a null-prototype object is plain, so it crosses rather than being refused', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['id'] = 'p1';
    expect(check({ row: bare } as JsxProps, ['row'])).toEqual({ row: { id: 'p1' } });
  });
});
