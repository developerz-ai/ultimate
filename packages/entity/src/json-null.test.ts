// Single responsibility: every parser that judges a whole row reads a NOT NULL `jsonb` column's
// `null` as the JSON value its schema judges — `$parse`, the wire `$schema`, and `$view`. The two
// drivers' half of the rule is `json-null-parity.test.ts`.

import { afterAll, describe, expect, test } from 'bun:test';
import { t, validate } from '@ultimat3/schema';
import { uuid } from './columns';
import { json } from './columns-data';
import { entity } from './entity';
import { holdsJsonNull } from './json-null';
import { clearRegistry } from './registry';

const shape = t.object({ a: t.number });

const docs = entity('json_null_docs', {
  columns: {
    id: uuid().primaryKey(),
    payload: json(t.nullable(shape)),
    strict: json(shape),
    note: json(shape).nullable(),
  },
});

const ID = '00000000-0000-7000-8000-000000000001';
const row = { id: ID, payload: null, strict: { a: 1 }, note: null };

describe('holdsJsonNull', () => {
  test('only a NOT NULL jsonb column holds the JSON literal', () => {
    expect(holdsJsonNull(docs.$columns.payload.$meta)).toBe(true);
    expect(holdsJsonNull(docs.$columns.strict.$meta)).toBe(true);
    expect(holdsJsonNull(docs.$columns.note.$meta)).toBe(false);
    expect(holdsJsonNull(docs.$columns.id.$meta)).toBe(false);
  });
});

describe('a NOT NULL json column whose schema admits null', () => {
  test('$parse keeps the null', () => {
    expect(docs.$parse(row)).toEqual(row);
  });

  test('the wire schema keeps the null', () => {
    expect(validate(docs.$schema, row)).toEqual({ value: row });
  });

  test('a view keeps the null', () => {
    expect(validate(docs.$view(['id', 'payload']), row)).toEqual({
      value: { id: ID, payload: null },
    });
  });

  test('absent is still required: only an explicit null is the JSON value', () => {
    expect(() => docs.$parse({ id: ID, strict: { a: 1 } })).toThrow(/is required/);
  });
});

describe('a NOT NULL json column whose schema refuses null', () => {
  test('$parse refuses by the schema, not by the NOT NULL rule', () => {
    expect(() => docs.$parse({ ...row, strict: null })).toThrow(/column\.json/);
  });

  test('a view reports the schema issue', () => {
    const answer = validate(docs.$view(['id', 'strict']), { id: ID, strict: null });
    expect(answer.issues?.length).toBe(1);
    expect(JSON.stringify(answer.issues)).not.toContain('required');
  });
});

afterAll(() => {
  clearRegistry();
});
