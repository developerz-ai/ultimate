// The compiler, construct by construct: each shape it reads, each it refuses with the pointer it
// stopped at, and the two properties a client depends on — recursion survives, `--only` really
// leaves a refused construct out.

import { describe, expect, test } from 'bun:test';
import { compileOpenApi } from './openapi-compile';
import type { ClientType } from './openapi-compile-ir';

const doc = (
  schemas: Readonly<Record<string, unknown>>,
  paths: Readonly<Record<string, unknown>> = {},
): unknown => ({
  openapi: '3.1.0',
  info: { title: 'Billing', version: '2026-11-01' },
  paths: {
    '/things': {
      get: {
        operationId: 'list-things',
        tags: ['things'],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
          },
        },
      },
    },
    ...paths,
  },
  components: { schemas },
});

/** The compiled `Thing` component. */
const thing = (schema: unknown): ClientType | undefined =>
  compileOpenApi(doc({ Thing: schema }), { source: 'test' }).types.get('Thing');

const refusal = (run: () => unknown): { code?: string; meta?: { pointer?: string } } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; meta?: { pointer?: string } };
  }
  return expect.unreachable('the compiler accepted a construct it must refuse');
};

describe('openapi compile · shapes', () => {
  test('an object: required and optional fields, in document order', () => {
    expect(
      thing({
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, n: { type: 'integer' } },
        required: ['id'],
      }),
    ).toEqual({
      kind: 'object',
      fields: [
        { name: 'id', required: true, type: { kind: 'string' } },
        { name: 'n', required: false, type: { kind: 'number', integer: true } },
      ],
    });
  });

  test('arrays, records and the schema that states nothing', () => {
    expect(thing({ type: 'array', items: { type: 'number' } })).toEqual({
      kind: 'array',
      items: { kind: 'number', integer: false },
    });
    expect(thing({ type: 'object', additionalProperties: { type: 'boolean' } })).toEqual({
      kind: 'record',
      values: { kind: 'boolean' },
    });
    expect(thing({})).toEqual({ kind: 'unknown' });
  });

  test('enum and const are literal unions; null joins as a member', () => {
    expect(thing({ type: 'string', enum: ['a', 'b'] })).toEqual({
      kind: 'union',
      members: [
        { kind: 'literal', value: 'a' },
        { kind: 'literal', value: 'b' },
      ],
    });
    expect(thing({ const: 3 })).toEqual({ kind: 'literal', value: 3 });
    expect(thing({ type: ['string', 'null'] })).toEqual({
      kind: 'union',
      members: [{ kind: 'string' }, { kind: 'null' }],
    });
    expect(thing({ type: 'string', nullable: true })).toEqual({
      kind: 'union',
      members: [{ kind: 'string' }, { kind: 'null' }],
    });
  });

  test('oneOf and anyOf are unions; properties beside them merge into every member', () => {
    expect(thing({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual({
      kind: 'union',
      members: [{ kind: 'string' }, { kind: 'number', integer: true }],
    });
    const page = thing({
      type: 'object',
      properties: { more: { type: 'boolean' }, rows: { type: 'array' } },
      required: ['more', 'rows'],
      anyOf: [
        { properties: { more: { const: true } } },
        { properties: { more: { const: false } } },
      ],
    });
    expect(page).toEqual({
      kind: 'union',
      members: [true, false].map((value) => ({
        kind: 'object',
        fields: [
          { name: 'more', required: true, type: { kind: 'literal', value } },
          { name: 'rows', required: true, type: { kind: 'array', items: { kind: 'unknown' } } },
        ],
      })),
    });
  });

  test('allOf merges objects, a $ref followed, the later declaration narrowing the earlier', () => {
    const compiled = compileOpenApi(
      doc({
        Base: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
        Thing: {
          allOf: [
            { $ref: '#/components/schemas/Base' },
            { properties: { kind: { enum: ['a'] }, extra: { type: 'string' } } },
          ],
        },
      }),
      { source: 'test' },
    );
    expect(compiled.types.get('Thing')).toEqual({
      kind: 'object',
      fields: [
        { name: 'kind', required: true, type: { kind: 'literal', value: 'a' } },
        { name: 'extra', required: false, type: { kind: 'string' } },
      ],
    });
  });

  test('a recursive $ref is a name, compiled once', () => {
    const compiled = compileOpenApi(
      doc({
        Thing: {
          type: 'object',
          properties: {
            children: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
          },
        },
      }),
      { source: 'test' },
    );
    expect(compiled.types.get('Thing')).toEqual({
      kind: 'object',
      fields: [
        {
          name: 'children',
          required: false,
          type: { kind: 'array', items: { kind: 'ref', name: 'Thing' } },
        },
      ],
    });
  });
});

describe('openapi compile · operations', () => {
  const compiled = compileOpenApi(
    doc(
      { Thing: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      {
        '/things/{thingId}': {
          parameters: [{ in: 'path', name: 'thingId', schema: { type: 'string' } }],
          post: {
            operationId: 'things.update',
            tags: ['things'],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
            responses: {
              '204': { description: 'done' },
              '404': { description: 'gone', 'x-ultimate-errors': ['X_THING_GONE'] },
            },
          },
        },
      },
    ),
    { source: 'test' },
  );
  const update = compiled.operations.find((op) => op.name === 'thingsUpdate');

  test('names come from operationId, sorted; the path-item parameter is inherited', () => {
    expect(compiled.operations.map((op) => op.name)).toEqual(['listThings', 'thingsUpdate']);
    expect(update?.parameters).toEqual([
      { name: 'thingId', in: 'path', required: true, type: { kind: 'string' } },
    ]);
  });

  test('an object body is fields, a 204 answers nothing, a declared refusal is listed', () => {
    expect(update?.body).toEqual({
      mode: 'fields',
      required: true,
      type: { kind: 'ref', name: 'Thing' },
    });
    expect(update?.response).toBeUndefined();
    expect(update?.refusals).toEqual(['X_THING_GONE']);
  });

  test('--only keeps the operations carrying a tag, and only the types they reach', () => {
    const only = compileOpenApi(
      doc(
        { Thing: { type: 'string' }, Other: { not: {} } },
        {
          '/other': {
            get: {
              operationId: 'other',
              tags: ['other'],
              responses: {
                '200': {
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Other' } },
                  },
                },
              },
            },
          },
        },
      ),
      { source: 'test', only: ['things'] },
    );
    expect(only.operations.map((op) => op.name)).toEqual(['listThings']);
    expect([...only.types.keys()]).toEqual(['Thing']);
  });
});

describe('openapi compile · refusals', () => {
  test('an unread keyword is X_CLIENT_SPEC_UNSUPPORTED naming its pointer', () => {
    const error = refusal(() => thing({ type: 'object', patternProperties: {} }));
    expect(error.code).toBe('X_CLIENT_SPEC_UNSUPPORTED');
    expect(error.meta?.pointer).toBe('#/components/schemas/Thing/patternProperties');
  });

  test('a pointer escapes the path key, so it names one segment', () => {
    const error = refusal(() =>
      compileOpenApi(
        doc(
          { Thing: { type: 'string' } },
          { '/a/{b}': { get: { parameters: [{ in: 'cookie', name: 's', schema: {} }] } } },
        ),
        { source: 'test' },
      ),
    );
    expect(error.meta?.pointer).toBe('#/paths/~1a~1{b}/get/parameters/0/in');
  });

  test('a non-JSON body, an external $ref and a typed rest beside properties are refused', () => {
    expect(
      refusal(() =>
        compileOpenApi(
          doc(
            { Thing: { type: 'string' } },
            {
              '/csv': {
                get: { responses: { '200': { content: { 'text/csv': { schema: {} } } } } },
              },
            },
          ),
          { source: 'test' },
        ),
      ).meta?.pointer,
    ).toBe('#/paths/~1csv/get/responses/200/content');
    expect(refusal(() => thing({ $ref: 'other.json#/X' })).meta?.pointer).toBe(
      '#/components/schemas/Thing/$ref',
    );
    expect(
      refusal(() =>
        thing({ properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }),
      ).code,
    ).toBe('X_CLIENT_SPEC_UNSUPPORTED');
  });

  test('a document that is not OpenAPI 3.0 or 3.1 is X_CLIENT_SPEC_INVALID', () => {
    expect(refusal(() => compileOpenApi({ swagger: '2.0' }, { source: 'v2.json' })).code).toBe(
      'X_CLIENT_SPEC_INVALID',
    );
    expect(refusal(() => compileOpenApi([], { source: 'list.json' })).code).toBe(
      'X_CLIENT_SPEC_INVALID',
    );
  });
});
