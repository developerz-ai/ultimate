import { describe, expect, test } from 'bun:test';
import { diffInput, onlyAddsOptionalProperties } from './diff-input';

const schema = (properties: Record<string, unknown>, required: string[], extra = {}) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
});
const before = schema({ bank: { type: 'string' }, reference: { type: 'string' } }, ['bank']);

describe('an input schema change', () => {
  test('a removed, retyped or newly required property is breaking', () => {
    for (const after of [
      schema({ bank: { type: 'string' } }, ['bank']),
      schema({ bank: { type: 'number' }, reference: { type: 'string' } }, ['bank']),
      schema({ bank: { type: 'string' }, reference: { type: 'string' } }, ['bank', 'reference']),
      schema(
        { bank: { type: 'string' }, reference: { type: 'string' }, trigger: { type: 'string' } },
        ['bank', 'trigger'],
      ),
      schema({ bank: { type: 'string' }, reference: { type: 'string' } }, ['bank'], {
        additionalProperties: true,
      }),
      { type: 'array' },
    ]) {
      expect(diffInput('actions.a.input', before, after, 'input schema changed')).toEqual([
        { kind: 'breaking', path: 'actions.a.input', detail: 'input schema changed' },
      ]);
    }
  });

  test('a new optional property is additive: every old payload still parses', () => {
    const after = schema(
      { bank: { type: 'string' }, reference: { type: 'string' }, trigger: { enum: ['user'] } },
      ['bank'],
    );
    expect(diffInput('actions.a.input', before, after, 'x')).toEqual([
      { kind: 'additive', path: 'actions.a.input', detail: 'input gained optional properties' },
    ]);
  });

  test('an open schema (extra keys allowed) never reads additive: a new typed key can refuse old payloads', () => {
    const open = { ...before, additionalProperties: true };
    const openAfter = {
      ...open,
      properties: { ...open.properties, trigger: { type: 'string' } },
    };
    expect(onlyAddsOptionalProperties(open, openAfter)).toBe(false);
    const { additionalProperties: _drop, ...omitted } = before;
    expect(
      onlyAddsOptionalProperties(omitted, {
        ...omitted,
        properties: { ...omitted.properties, trigger: { type: 'string' } },
      }),
    ).toBe(false);
  });

  test('the same schema is no change; a non-object schema is never additive', () => {
    expect(diffInput('p', before, structuredClone(before), 'x')).toEqual([]);
    expect(onlyAddsOptionalProperties({ type: 'string' }, { type: 'string', minLength: 1 })).toBe(
      false,
    );
    expect(onlyAddsOptionalProperties(null, before)).toBe(false);
  });
});

describe('an input enum change', () => {
  const topics = (values: string[], extra = {}) =>
    schema({ topic: { enum: values } }, ['topic'], extra);

  test('a widened enum is additive: every old payload still parses', () => {
    expect(diffInput('actions.a.input', topics(['a', 'b']), topics(['a', 'b', 'c']), 'x')).toEqual([
      { kind: 'additive', path: 'actions.a.input', detail: 'input accepts more enum values' },
    ]);
  });

  test('a removed enum value, or a widening beside any other change, is breaking', () => {
    for (const after of [
      topics(['a']),
      topics(['a', 'c']),
      topics(['a', 'b', 'c'], { additionalProperties: true }),
      schema({ topic: { enum: ['a', 'b', 'c'] }, more: { type: 'string' } }, ['topic', 'more']),
    ]) {
      expect(diffInput('actions.a.input', topics(['a', 'b']), after, 'x')).toEqual([
        { kind: 'breaking', path: 'actions.a.input', detail: 'x' },
      ]);
    }
  });

  test('a widened anyOf branch, the other untouched, is additive', () => {
    const union = (values: string[]) => ({ anyOf: [{ enum: values }, { type: 'number' }] });
    expect(diffInput('q', union(['a']), union(['a', 'b']), 'x')).toEqual([
      { kind: 'additive', path: 'q', detail: 'input accepts more enum values' },
    ]);
  });

  test('a reordered enum is no change', () => {
    expect(diffInput('q', topics(['a', 'b']), topics(['b', 'a']), 'x')).toEqual([]);
  });

  test('a widening where accepting more can refuse an old payload is breaking', () => {
    const pairs: [unknown, unknown][] = [
      // oneOf: `b` now matches two branches, so it is refused.
      [
        { oneOf: [{ enum: ['a'] }, { type: 'string' }] },
        { oneOf: [{ enum: ['a', 'b'] }, { type: 'string' }] },
      ],
      // a literal is compared as a value, never as a schema.
      [{ const: { enum: ['a'] } }, { const: { enum: ['a', 'b'] } }],
      // a condition that matches more applies its `then` to more.
      // (parsed: a `then` key in a literal makes a thenable.)
      [
        JSON.parse('{"if":{"enum":["a"]},"then":{"const":"a"}}'),
        JSON.parse('{"if":{"enum":["a","b"]},"then":{"const":"a"}}'),
      ],
      // a widening beside a new constraint on the same node.
      [
        { enum: ['a'], type: 'string' },
        { enum: ['a', 'b'], type: 'string', minLength: 2 },
      ],
      // a removed own `__proto__` property, at the top and nested: `in` would find the prototype.
      [
        JSON.parse('{"type":"object","properties":{"__proto__":{}},"additionalProperties":false}'),
        { type: 'object', properties: {}, additionalProperties: false },
      ],
      [
        JSON.parse('{"items":{"properties":{"__proto__":{}},"additionalProperties":false}}'),
        { items: { properties: {}, additionalProperties: false } },
      ],
    ];
    for (const [was, now] of pairs) {
      expect(diffInput('q', was, now, 'x')).toEqual([{ kind: 'breaking', path: 'q', detail: 'x' }]);
    }
  });
});
