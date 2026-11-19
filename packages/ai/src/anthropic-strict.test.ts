// `strict: true` on the Anthropic wire is a promise the server checks: a schema outside the
// documented subset, or a request past one of the three caps, is a 400. Each rule is one case.
import { describe, expect, test } from 'bun:test';
import {
  anthropicTools,
  MAX_STRICT_OPTIONAL,
  MAX_STRICT_TOOLS,
  MAX_STRICT_UNIONS,
  strictSubset,
} from './anthropic-strict';
import type { JsonSchema, LlmTool } from './tools';

const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const tool = (name: string, input_schema: JsonSchema, strict = true): LlmTool => ({
  name,
  description: name,
  input_schema,
  strict,
});

const claimed = (tools: readonly LlmTool[]): readonly boolean[] =>
  anthropicTools(tools).map((one) => one.strict === true);

describe('strictSubset()', () => {
  test('a closed object of plain types, enums, nullables and arrays is inside it', () => {
    const schema = object({
      title: { type: 'string' },
      kind: { type: 'string', enum: ['a', 'b'] },
      note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      nested: object({ n: { type: 'integer' } }),
    });
    expect(strictSubset(schema)).toEqual({ optional: 0, unions: 1 });
  });

  test.each<[string, JsonSchema]>([
    ['minLength', { type: 'string', minLength: 1 }],
    ['maxLength', { type: 'string', maxLength: 80 }],
    ['minimum', { type: 'number', minimum: 0 }],
    ['maximum', { type: 'number', maximum: 1 }],
    ['minItems above 1', { type: 'array', items: { type: 'string' }, minItems: 2 }],
    ['maxItems', { type: 'array', items: { type: 'string' }, maxItems: 5 }],
    ['pattern', { type: 'string', pattern: '^a' }],
    ['an open object', { type: 'object', properties: {}, additionalProperties: true }],
    ['an object that does not say', { type: 'object', properties: {} }],
    ['anyOf beside type', { type: 'string', anyOf: [{ type: 'string' }] }],
  ])('%s is outside it', (_name, child) => {
    expect(strictSubset(object({ child }))).toBeUndefined();
    // Nested one level down, and inside a union: the server checks the whole document.
    expect(strictSubset(object({ wrap: { anyOf: [object({ child }), { type: 'null' }] } }))).toBe(
      undefined,
    );
    expect(strictSubset(object({ list: { type: 'array', items: child } }))).toBeUndefined();
  });

  test('optional keys and unions are counted through the whole document', () => {
    const schema = object(
      {
        a: { type: 'string' },
        b: object({ c: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, []),
      },
      ['b'],
    );
    expect(strictSubset(schema)).toEqual({ optional: 2, unions: 1 });
  });
});

describe('anthropicTools()', () => {
  test('a tool that never asked for strict is never given it', () => {
    expect(claimed([tool('loose', object({ a: { type: 'string' } }), false)])).toEqual([false]);
  });

  test('the tool itself is sent unchanged apart from the flag', () => {
    const bounded = tool('bounded', object({ a: { type: 'string', minLength: 1 } }));
    const [sent] = anthropicTools([bounded]);
    expect(sent).toEqual({
      name: 'bounded',
      description: 'bounded',
      input_schema: bounded.input_schema,
    });
  });

  test(`at most ${MAX_STRICT_TOOLS} tools of one request are strict`, () => {
    const many = Array.from({ length: MAX_STRICT_TOOLS + 3 }, (_, n) =>
      tool(`t${n}`, object({ a: { type: 'string' } })),
    );
    expect(claimed(many).filter(Boolean).length).toBe(MAX_STRICT_TOOLS);
  });

  test(`optional parameters across strict tools stop at ${MAX_STRICT_OPTIONAL}`, () => {
    const six = (name: string) =>
      tool(
        name,
        object(
          Object.fromEntries(Array.from({ length: 6 }, (_, n) => [`p${n}`, { type: 'string' }])),
          [],
        ),
      );
    // Four tools of six optionals reach the cap exactly; the fifth is sent without the flag.
    expect(claimed(['a', 'b', 'c', 'd', 'e'].map(six))).toEqual([true, true, true, true, false]);
  });

  test(`union parameters across strict tools stop at ${MAX_STRICT_UNIONS}`, () => {
    const unions = (name: string, count: number) =>
      tool(
        name,
        object(
          Object.fromEntries(
            Array.from({ length: count }, (_, n) => [
              `p${n}`,
              { anyOf: [{ type: 'string' as const }, { type: 'null' as const }] },
            ]),
          ),
        ),
      );
    expect(claimed([unions('a', 10), unions('b', 10), unions('c', 6)])).toEqual([
      true,
      false,
      true,
    ]);
  });
});
