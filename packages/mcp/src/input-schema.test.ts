// The projection's one rule, executable: `tools/list` publishes ONLY keywords
// `validate-args.ts` enforces.
//
// "Handing an agent a keyword the server ignores is worse than omitting it — the agent obeys a
// rule nothing checks and gets a silent pass." `format` was published verbatim and checked
// nowhere: a tool declaring `t.uuid` told the agent `format: 'uuid'` and then accepted
// `"not-a-uuid"` with `ok: true`, while the action's own parse rejected it. Two contracts for one
// declaration, and the agent was judged against the one it never saw.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { toWireSchema } from './input-schema';
import { validateArgs } from './validate-args';
import type { JsonSchema } from './wire';

/**
 * Every keyword the wire subset may carry: each one is either ENFORCED by `validate-args.ts` or is
 * pure annotation that claims nothing about a value. A keyword that is neither is a silent pass.
 */
const ENFORCED = new Set([
  'type',
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
  'anyOf',
]);
const ANNOTATION = new Set(['title', 'description']);

/** Every key that appears anywhere in a projected schema, at any depth. */
function keysIn(schema: JsonSchema, out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    if (key === 'properties') {
      for (const child of Object.values(value as Record<string, JsonSchema>)) keysIn(child, out);
    }
    if (key === 'items') keysIn(value as JsonSchema, out);
    if (key === 'anyOf') for (const branch of value as JsonSchema[]) keysIn(branch, out);
  }
  return out;
}

/** Every semantic format the framework has, in one declaration — the widest projection there is. */
const Everything = t.object({
  postId: t.uuid,
  contact: t.email,
  homepage: t.url,
  when: t.date,
  zone: t.timezone,
  locale: t.locale,
  handle: t.slug,
  cursor: t.cursor,
  title: t.string.min(1).max(10),
  count: t.number.int().min(1).max(50),
  nested: t.object({ childId: t.uuid }),
  tags: t.array(t.email),
  choice: t.enum(['a', 'b']),
  maybe: t.optional(t.uuid),
});

describe('toWireSchema publishes only what this server enforces', () => {
  test('no keyword outside the subset reaches the wire, at any depth', () => {
    for (const key of keysIn(toWireSchema(Everything))) {
      expect(ENFORCED.has(key) || ANNOTATION.has(key)).toBe(true);
    }
  });

  test('format specifically is dropped — it named a rule nothing checked', () => {
    const wire = toWireSchema(t.object({ postId: t.uuid, contact: t.email }));
    const properties = wire.properties ?? {};
    expect(Object.hasOwn(properties['postId'] ?? {}, 'format')).toBe(false);
    expect(Object.hasOwn(properties['contact'] ?? {}, 'format')).toBe(false);
    expect(properties['postId']?.type).toBe('string');
  });

  test('a format that also carries a pattern keeps the pattern, which IS enforced', () => {
    const wire = toWireSchema(t.object({ handle: t.slug }));
    const pattern = wire.properties?.['handle']?.pattern;
    expect(typeof pattern).toBe('string');
    expect(validateArgs(wire, { handle: 'NOT A SLUG' }).ok).toBe(false);
    expect(validateArgs(wire, { handle: 'a-slug' }).ok).toBe(true);
  });

  test('every published constraint refuses at least one value', () => {
    const wire = toWireSchema(Everything);
    const properties = wire.properties ?? {};
    // minLength/maxLength, minimum/maximum, enum, type and required all still bite.
    expect(validateArgs(properties['title'] ?? {}, '').ok).toBe(false);
    expect(validateArgs(properties['count'] ?? {}, 0).ok).toBe(false);
    expect(validateArgs(properties['choice'] ?? {}, 'c').ok).toBe(false);
    expect(validateArgs(wire, {}).ok).toBe(false);
  });

  test('the shape itself is unchanged: properties, required and nesting survive', () => {
    const wire = toWireSchema(t.object({ postId: t.uuid, nested: t.object({ n: t.number }) }));
    expect(wire.type).toBe('object');
    expect(wire.required).toContain('postId');
    expect(wire.properties?.['nested']?.properties?.['n']?.type).toBe('number');
  });
});

/**
 * The same rule one level down: publishing a keyword this server enforces is not enough if the two
 * enforcers count in different UNITS. `minLength`/`maxLength` are minted by `@ultimat3/schema`'s
 * `charCount` — code points, which is what JSON Schema defines them over and what the action's own
 * re-parse applies — and `validate-args.ts` read `input.length`, which is UTF-16 code units.
 *
 * Both directions were live, and the second is the worse one: it refuses a call the tool would have
 * served, quoting a bound the agent obeyed, with no re-parse behind it to disagree.
 */
describe('the published bound and the enforced bound count the same unit', () => {
  const verdictsAgree = (schema: ReturnType<typeof t.string.min>, value: string): void => {
    const wire = toWireSchema(t.object({ title: schema }));
    const mcp = validateArgs(wire, { title: value });
    const parsed = t.object({ title: schema })['~standard'].validate({ title: value });
    const schemaOk = !(parsed instanceof Promise) && parsed.issues === undefined;
    expect(mcp.ok).toBe(schemaOk);
  };

  test('an astral string at the exact bound is not a silent pass', () => {
    // '👍a' is 3 UTF-16 code units and 2 code points, so `.length` reads it as satisfying min(3)
    // while the action's re-parse answers X_INPUT_INVALID — the silent pass this file exists for.
    verdictsAgree(t.string.min(3).max(3), '👍a');
  });

  test('an astral string inside the bound is not refused on a bound the agent obeyed', () => {
    // '👍👍' is 4 code units and 2 code points: max(3) admits it and `.length` refused it, with
    // nothing downstream to correct the answer.
    verdictsAgree(t.string.min(1).max(3), '👍👍');
  });

  test('and an ASCII string still decides the same way it always did', () => {
    verdictsAgree(t.string.min(3).max(3), 'abc');
    verdictsAgree(t.string.min(3).max(3), 'ab');
    verdictsAgree(t.string.min(1).max(3), 'abcd');
  });
});
