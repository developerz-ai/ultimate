// The property that matters is not which value comes out, it is that the schema ACCEPTS it —
// so every case parses the sample back through the schema that produced it.

import { describe, expect, test } from 'bun:test';
import type { AnySchema } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { sampleInput } from './sample-input';

const accepts = (schema: AnySchema): boolean =>
  schema.safeParse(sampleInput(schema)).issues === undefined;

describe('sampleInput', () => {
  test('every t member accepts its own sample', () => {
    const rejected = (
      [
        ['string', t.string],
        ['number', t.number],
        ['boolean', t.boolean],
        ['uuid', t.uuid],
        ['email', t.email],
        ['url', t.url],
        ['date', t.date],
        ['money', t.money],
        ['timezone', t.timezone],
        ['locale', t.locale],
        ['slug', t.slug],
        ['cursor', t.cursor],
      ] as const
    )
      .filter(([, schema]) => !accepts(schema))
      .map(([label]) => label);
    // Named, not counted: a failure has to say WHICH format lost its sample.
    expect(rejected).toEqual([]);
  });

  test('an object sample carries every required key and no optional one', () => {
    const schema = t.object({
      postId: t.uuid,
      orgId: t.uuid,
      notify: t.boolean.default(true),
      note: t.string.optional(),
    });
    expect(sampleInput(schema)).toEqual({
      postId: '00000000-0000-4000-8000-000000000000',
      orgId: '00000000-0000-4000-8000-000000000000',
    });
    expect(accepts(schema)).toBe(true);
  });

  test('a nested object is sampled all the way down', () => {
    const schema = t.object({ author: t.object({ id: t.uuid, tags: t.array(t.string) }) });
    expect(sampleInput(schema)).toEqual({
      author: { id: '00000000-0000-4000-8000-000000000000', tags: [] },
    });
  });

  test('a nullable field samples as null — the smallest value it accepts', () => {
    const schema = t.object({ cover: t.nullable(t.url) });
    expect(sampleInput(schema)).toEqual({ cover: null });
    expect(accepts(schema)).toBe(true);
  });

  test('string length bounds are honoured in both directions', () => {
    expect(sampleInput(t.string.min(20))).toBe('samplexxxxxxxxxxxxxx');
    expect(sampleInput(t.string.max(3))).toBe('sam');
    expect(accepts(t.string.min(20))).toBe(true);
    expect(accepts(t.string.max(3))).toBe(true);
  });

  test('number bounds are honoured, and an integer stays an integer', () => {
    expect(sampleInput(t.number)).toBe(0);
    expect(sampleInput(t.number.min(7))).toBe(7);
    expect(sampleInput(t.number.max(-3))).toBe(-3);
    expect(sampleInput(t.number.int().min(0.5))).toBe(1);
    expect(sampleInput(t.number.int().max(-3.5))).toBe(-4);
    expect(accepts(t.number.int().max(-3.5))).toBe(true);
  });

  test('enum, literal, array, record and union sample from their own declaration', () => {
    expect(sampleInput(t.enumerated('draft', 'published'))).toBe('draft');
    expect(sampleInput(t.literal(7))).toBe(7);
    expect(sampleInput(t.array(t.uuid))).toEqual([]);
    expect(sampleInput(t.record(t.string))).toEqual({});
    expect(sampleInput(t.union(t.uuid, t.number))).toBe('00000000-0000-4000-8000-000000000000');
  });

  test('money samples as minor units plus a currency, never a bare amount', () => {
    expect(sampleInput(t.money)).toEqual({ minor: 0, currency: 'USD' });
  });

  test('a schema the provider cannot describe degrades to an empty object', () => {
    // A foreign Standard Schema with no IR: the caller reports the rejection as drift, so the
    // one thing this must not do is throw and take the generated contract test with it.
    const foreign = {
      '~standard': { version: 1 as const, vendor: 'other', validate: () => ({ value: 1 }) },
    };
    expect(sampleInput(foreign)).toEqual({});
  });

  test('a constraint the IR does not carry yields a value the schema rejects, not a throw', () => {
    // The honest half of "best effort": `pattern` alone cannot be inverted, so the sample fails
    // its own schema and contractTestsFor turns that into X_CONTRACT_DRIFT naming `input:`.
    const digits = t.string.pattern(/^\d+$/);
    expect(sampleInput(digits)).toBe('sample');
    expect(accepts(digits)).toBe(false);
  });
});
