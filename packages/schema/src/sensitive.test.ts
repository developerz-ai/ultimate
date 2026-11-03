// Single responsibility: pins `.sensitive()` — the flag survives every wrapper, publishes as
// `writeOnly`, masks at every nesting, costs an unflagged schema nothing, and is refused in an
// output. WHY: the mask is the only thing between a card number and an audit row.

import { describe, expect, test } from 'bun:test';
import { isSchemaError } from './errors';
import { toJsonSchema } from './json-schema';
import { assertNoSensitiveOutput, maskSensitive } from './sensitive';
import { t } from './t';

const R = '[redacted]';

describe('.sensitive() survives the wrappers', () => {
  test('optional, nullable, default and describe keep the flag', () => {
    expect(t.string.sensitive().optional().node.sensitive).toBe(true);
    expect(t.string.sensitive().nullable().node.sensitive).toBe(true);
    expect(t.string.sensitive().describe('pan').node.sensitive).toBe(true);
    expect(t.string.optional().sensitive().node.optional).toBe(true);
  });

  test('a field flagged inside array, record, union and extend/pick stays flagged', () => {
    const card = t.object({ pan: t.string.sensitive(), note: t.string });
    expect(t.array(card).node.items?.properties?.['pan']?.sensitive).toBe(true);
    expect(t.record(card).node.valueNode?.properties?.['pan']?.sensitive).toBe(true);
    expect(t.union(card, t.number).node.anyOf?.[0]?.properties?.['pan']?.sensitive).toBe(true);
    expect(card.pick('pan').node.properties?.['pan']?.sensitive).toBe(true);
    expect(card.extend({}).node.properties?.['pan']?.sensitive).toBe(true);
  });

  test('publishes JSON Schema writeOnly, and only where it was declared', () => {
    const schema = toJsonSchema(t.object({ pan: t.string.sensitive(), note: t.string }));
    expect(schema.properties?.['pan']?.writeOnly).toBe(true);
    expect('writeOnly' in (schema.properties?.['note'] ?? {})).toBe(false);
    expect('writeOnly' in schema).toBe(false);
  });

  test('a sensitive field still validates exactly as before', () => {
    expect(t.string.min(3).sensitive().safeParse('ab').issues?.[0]?.rule).toBe('string.min');
  });
});

describe('maskSensitive', () => {
  test('an unflagged schema answers the very same reference', () => {
    const value = { note: 'hello', lines: [{ qty: 1 }] };
    const schema = t.object({ note: t.string, lines: t.array(t.object({ qty: t.number })) });
    expect(maskSensitive(schema, value, R)).toBe(value);
  });

  test('masks a top-level field and leaves its neighbours and the original alone', () => {
    const schema = t.object({ cardPan: t.string.sensitive(), note: t.string });
    const value = { cardPan: '4111111111111111', note: 'hi' };
    expect(maskSensitive(schema, value, R)).toEqual({ cardPan: R, note: 'hi' });
    expect(value.cardPan).toBe('4111111111111111');
  });

  test('masks through objects, arrays, records and nullable wrappers', () => {
    const schema = t.object({
      payer: t.object({ ssn: t.string.sensitive().nullable() }),
      cards: t.array(t.object({ pan: t.string.sensitive() })),
      byName: t.record(t.object({ iban: t.string.sensitive() })),
    });
    const masked = maskSensitive(
      schema,
      {
        payer: { ssn: '078-05-1120' },
        cards: [{ pan: '4111' }, { pan: '5555' }],
        byName: { main: { iban: 'DE89' } },
      },
      R,
    );
    expect(masked).toEqual({
      payer: { ssn: R },
      cards: [{ pan: R }, { pan: R }],
      byName: { main: { iban: R } },
    });
  });

  test('a union masks any branch’s flagged key, without resolving the branch', () => {
    const schema = t.union(
      t.object({ kind: t.literal('card'), pan: t.string.sensitive() }),
      t.object({ kind: t.literal('bank'), iban: t.string.sensitive() }),
    );
    // A value matching neither branch exactly still loses both keys: fail closed.
    expect(maskSensitive(schema, { kind: 'bank', pan: 'x', iban: 'y' }, R)).toEqual({
      kind: 'bank',
      pan: R,
      iban: R,
    });
  });

  test('an absent sensitive key stays absent; a wholly sensitive root is masked whole', () => {
    const schema = t.object({ pin: t.string.sensitive().optional() });
    expect(maskSensitive(schema, {}, R)).toEqual({});
    expect(maskSensitive(t.string.sensitive(), 'secret', R)).toBe(R);
  });

  test('a schema nothing can introspect, or a value of the wrong shape, passes through', () => {
    const foreign = { '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } };
    expect(maskSensitive(foreign, { a: 1 }, R)).toEqual({ a: 1 });
    const schema = t.object({ pan: t.string.sensitive() });
    expect(maskSensitive(schema, 'not an object', R)).toBe('not an object');
  });

  test('a key named __proto__ on the value stays a key', () => {
    const schema = t.object({ pan: t.string.sensitive() });
    const value = JSON.parse('{"pan":"1","__proto__":{"x":1}}') as Record<string, unknown>;
    const masked = maskSensitive(schema, value, R) as Record<string, unknown>;
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
    expect(Object.hasOwn(masked, '__proto__')).toBe(true);
  });
});

describe('assertNoSensitiveOutput', () => {
  test('refuses a sensitive field reachable from an output, naming the path', () => {
    const output = t.object({ rows: t.array(t.object({ ssn: t.string.sensitive() })) });
    try {
      assertNoSensitiveOutput('action "createPayer" output', output);
      expect.unreachable('a sensitive output was accepted');
    } catch (error) {
      expect(isSchemaError(error) && error.code).toBe('X_SCHEMA_SENSITIVE_OUTPUT');
      expect(String((error as Error).message)).toContain('rows[].ssn');
      expect(String((error as { fix: string }).fix)).toContain('rows[].ssn');
    }
  });

  test('finds one in a union branch and a record value', () => {
    expect(() =>
      assertNoSensitiveOutput('q', t.union(t.number, t.object({ pin: t.string.sensitive() }))),
    ).toThrow('X_SCHEMA_SENSITIVE_OUTPUT');
    expect(() => assertNoSensitiveOutput('q', t.record(t.string.sensitive()))).toThrow(
      'X_SCHEMA_SENSITIVE_OUTPUT',
    );
  });

  test('accepts an output with no flag, and a schema nothing can describe', () => {
    expect(() => assertNoSensitiveOutput('q', t.object({ note: t.string }))).not.toThrow();
    expect(() => assertNoSensitiveOutput('q', { not: 'a schema' })).not.toThrow();
  });
});
