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
