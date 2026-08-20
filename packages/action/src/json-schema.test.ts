/**
 * `jsonSchemaOf`/`mcpSchemaOf` REFUSE a schema the active provider cannot describe — publishing
 * "any object accepted" for an input `validateInput` rejects every payload from is the deploy that
 * succeeds while every caller is lied to — and `sortSchema` is the byte-stable ordering the
 * committed OpenAPI file depends on.
 */

import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { SchemaUnsupportedError, t } from '@ultimat3/schema';
import { jsonSchemaOf, mcpSchemaOf, normalizeJsonSchema, sortSchema } from './json-schema';

const Schema = t.object({ postId: t.uuid, title: t.string });

/** Structurally a schema, but carries no `node` — `nodeOf` cannot introspect it. */
const unintrospectable = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: undefined }) },
} as unknown as StandardSchemaV1;

// Bracket access throughout, and NOT a narrowed result type: `JsonSchemaObject` is
// `Record<string, unknown>` because the converter is a swappable `SchemaProvider` and a JSON
// Schema's keyword set is open — a fixed interface here would describe one provider's output and
// silently drop another's. `@ultimat3/mcp`'s narrow `JsonSchema` is tier 4 and unreachable from
// tier 3 anyway.
describe('jsonSchemaOf', () => {
  test('converts a real schema to a plain JSON-schema-shaped object', () => {
    const result = jsonSchemaOf(Schema);

    expect(result['type']).toBe('object');
    expect(result['properties']).toMatchObject({
      postId: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
    });
    expect(result['required']).toEqual(['postId', 'title']);
  });

  // `additionalProperties: true` was published for a schema the runtime rejects EVERYTHING from,
  // so the OpenAPI component and the MCP `inputSchema` both said "any object accepted" while
  // `validateInput` refused every payload. A spec that cannot be produced must not be produced.
  test('refuses, with the provider code, when the provider cannot introspect it', () => {
    expect(() => jsonSchemaOf(unintrospectable)).toThrow(/X_SCHEMA_UNSUPPORTED/);
  });
});

describe('mcpSchemaOf', () => {
  test('converts a real schema, draft-07, without a $schema key', () => {
    const result = mcpSchemaOf(Schema);

    expect(result['$schema']).toBeUndefined();
    expect(result['type']).toBe('object');
  });

  test('refuses, with the provider code, when the provider cannot introspect it', () => {
    expect(() => mcpSchemaOf(unintrospectable)).toThrow(/X_SCHEMA_UNSUPPORTED/);
  });
});

describe('sortSchema', () => {
  test('produces a deterministic, key-sorted copy regardless of build order', () => {
    const forward = { type: 'object', properties: { a: {}, b: {} }, additionalProperties: false };
    const backward = { additionalProperties: false, properties: { b: {}, a: {} }, type: 'object' };

    expect(JSON.stringify(sortSchema(forward))).toBe(JSON.stringify(sortSchema(backward)));
  });

  test('sorts keys at every depth', () => {
    const schema = { type: 'object', properties: { title: {}, postId: {} } };

    const sorted = sortSchema(schema);

    expect(Object.keys(sorted)).toEqual(['properties', 'type']);
    expect(Object.keys(sorted['properties'] as Record<string, unknown>)).toEqual([
      'postId',
      'title',
    ]);
  });

  test('drops undefined-valued keys, matching stableStringify', () => {
    const schema = { type: 'object', description: undefined };

    const sorted = sortSchema(schema);

    expect('description' in sorted).toBe(false);
  });
});

/**
 * A fix line is PASTED, so one naming an API that does not exist is worse than none — axiom 4.
 * `x verify`'s `errors` step checks a `fix:` for SHAPE and never for whether the member it names
 * is real, which is how "configure a provider whose toJsonSchema returns an object" shipped:
 * `SchemaProvider` has no such member and `toJsonSchema()` calls `introspect()` unconditionally.
 */
describe('the refusal a non-object conversion earns', () => {
  /**
   * The error itself, so its `fix:` can be read rather than matched against a message — NARROWED,
   * never cast. `catch` binds `unknown`, and reading `code`/`cause`/`fix` straight off it is the
   * same unchecked read this whole suite refuses one layer down: anything else that escaped would
   * answer `undefined` to every assertion below and the suite would pass on a refusal that never
   * happened. Not the refusal is rethrown; its own stack is the thing worth reading.
   */
  const refusalFrom = (convert: () => unknown): Record<string, unknown> => {
    try {
      normalizeJsonSchema(convert);
      return {};
    } catch (error) {
      if (!(error instanceof SchemaUnsupportedError)) throw error;
      return { code: error.code, cause: error.cause, fix: error.fix };
    }
  };

  test('keeps the shipped code and names the value it got', () => {
    const refusal = refusalFrom(() => 42);

    expect(refusal['code']).toBe('X_SCHEMA_UNSUPPORTED');
    expect(refusal['cause']).toContain('number');
  });

  test('the fix names introspect(), and no toJsonSchema member', () => {
    const fix = refusalFrom(() => null)['fix'];

    expect(fix).toContain('introspect');
    // The member that does not exist. `provider.ts` is the file that decides this, and the two
    // must agree: `introspect()` returning a `SchemaNode` is the whole of the provider seam.
    expect(fix).not.toContain('toJsonSchema');
  });

  test('an array is refused too — a JSON Schema object is never a list', () => {
    expect(refusalFrom(() => [])['code']).toBe('X_SCHEMA_UNSUPPORTED');
  });

  test('a throwable that is NOT the refusal propagates, rather than being read as one', () => {
    // `catch (error)` binds `unknown`, and casting it to a record makes every assertion above
    // read `undefined` off whatever actually escaped: this suite would have gone green on a
    // `TypeError` from inside `convert` while `normalizeJsonSchema` refused nothing at all.
    const boom = new TypeError('the converter itself blew up');
    let escaped: unknown;
    let returned: unknown = 'never assigned';
    try {
      returned = refusalFrom(() => {
        throw boom;
      });
    } catch (error) {
      escaped = error;
    }

    // Asserted by IDENTITY and with an explicit try/catch, not `expect(fn).toThrow(TypeError)`:
    // Bun 1.3.14 passes that matcher for a function that merely RETURNS an `Error`, which is
    // exactly the behaviour under test here — the assertion would have been unfalsifiable.
    expect(escaped).toBe(boom);
    expect(returned).toBe('never assigned');
  });
});
