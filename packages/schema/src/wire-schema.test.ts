// The one narrowing every MCP tool schema goes through. It lived in `@ultimat3/mcp` (tier 4), so
// `@ultimat3/action`'s `.tool()` (tier 3) could not reach it and published the full draft-07 shape
// while `tools/list` served this one — two documents for one declaration.

import { describe, expect, test } from 'bun:test';
import { t, toWireOutputSchema, toWireSchema } from './index';
import type { WireJsonSchema } from './wire-schema';

/** Every keyword the input subset may carry, at any depth. Anything else is a claim nobody holds. */
const INPUT_KEYWORDS = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'x-ultimate-pattern-flags',
  'anyOf',
]);

/** Structure only: a bound on an output is a promise nothing enforces on the way out. */
const OUTPUT_KEYWORDS = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'anyOf',
]);

function keysIn(schema: WireJsonSchema, out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const child of Object.values(value as Record<string, WireJsonSchema>))
        keysIn(child, out);
    }
    if (key === 'items') keysIn(value as WireJsonSchema, out);
    if (key === 'anyOf') for (const branch of value as WireJsonSchema[]) keysIn(branch, out);
  }
  return out;
}

const Everything = t.object({
  postId: t.uuid,
  contact: t.email,
  handle: t.slug,
  title: t.string.min(1).max(10).describe('the title'),
  count: t.number.int().min(1).max(50).default(5),
  nested: t.object({ childId: t.uuid }),
  tags: t.array(t.email),
  choice: t.enum(['a', 'b']),
  maybe: t.optional(t.uuid),
  note: t.nullable(t.string),
  meta: t.record(t.number),
});

describe('toWireSchema', () => {
  test('no keyword outside the input subset survives, at any depth', () => {
    const keys = [...keysIn(toWireSchema(Everything))];
    expect(keys.filter((key) => !INPUT_KEYWORDS.has(key))).toEqual([]);
  });

  test('format is dropped, and a format that also carries a pattern keeps the pattern', () => {
    const properties = toWireSchema(Everything).properties ?? {};
    expect(Object.hasOwn(properties['postId'] ?? {}, 'format')).toBe(false);
    expect(properties['postId']?.type).toBe('string');
    expect(typeof properties['handle']?.pattern).toBe('string');
  });

  test('a record schema says "extra keys allowed", never a value schema the subset cannot hold', () => {
    expect(toWireSchema(Everything).properties?.['meta']?.additionalProperties).toBe(true);
    expect(toWireSchema(Everything).additionalProperties).toBe(false);
  });

  test('the shape survives: required, nesting, defaults, descriptions, nullable branches', () => {
    const wire = toWireSchema(Everything);
    expect(wire.type).toBe('object');
    expect(wire.required).toContain('postId');
    expect(wire.properties?.['nested']?.properties?.['childId']?.type).toBe('string');
    expect(wire.properties?.['count']?.default).toBe(5);
    expect(wire.properties?.['title']?.description).toBe('the title');
    expect(wire.properties?.['note']?.anyOf?.map((branch) => branch.type)).toEqual([
      'string',
      'null',
    ]);
  });

  test('a property named __proto__ is published as a key, never as a prototype', () => {
    const properties = toWireSchema(t.object({ ['__proto__']: t.string, id: t.uuid })).properties;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.keys(properties ?? {}).sort()).toEqual(['__proto__', 'id']);
  });

  test('a schema the provider cannot introspect is refused, never published as "anything"', () => {
    expect(() => toWireSchema({})).toThrow();
  });
});

describe('toWireOutputSchema', () => {
  test('structure only: no bound, pattern, default or additionalProperties survives', () => {
    const shape = toWireOutputSchema(Everything);
    expect(shape).toBeDefined();
    const keys = [...keysIn(shape ?? {})];
    expect(keys.filter((key) => !OUTPUT_KEYWORDS.has(key))).toEqual([]);
  });

  test('a root that is not an object, or no schema at all, publishes no outputSchema', () => {
    expect(toWireOutputSchema(t.array(t.string))).toBeUndefined();
    expect(toWireOutputSchema(t.string)).toBeUndefined();
    expect(toWireOutputSchema({})).toBeUndefined();
  });

  test('a property named __proto__ is a key here too', () => {
    const shape = toWireOutputSchema(t.object({ ['__proto__']: t.string }));
    expect(Object.keys(shape?.properties ?? {})).toEqual(['__proto__']);
  });
});
