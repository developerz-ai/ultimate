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

  test('the same schema is no change; a non-object schema is never additive', () => {
    expect(diffInput('p', before, structuredClone(before), 'x')).toEqual([]);
    expect(onlyAddsOptionalProperties({ type: 'string' }, { type: 'string', minLength: 1 })).toBe(
      false,
    );
    expect(onlyAddsOptionalProperties(null, before)).toBe(false);
  });
});
