// Values read off the declaration: a `matches()` pattern no fixed text shape meets, and a
// `json(schema)` column, each answered with values the rule itself accepts — the same for a seed.

import { describe, expect, test } from 'bun:test';
import { entity, iff, invariant, json, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { declaredPatterns, patternOfCheck } from './seed-graph-patterns';
import { candidatesFor, type SeedColumn, type ValueContext } from './seed-graph-values';

const ctx = (patterns?: readonly RegExp[]): ValueContext => ({
  ordinal: 1,
  canary: '0a1b2c3d4e',
  position: 0,
  patterns,
  uuid: () => '00000000-0000-7000-8000-000000000000',
});

const orders = entity('sgv_orders', {
  columns: {
    id: uuid().primaryKey(),
    orderRef: text({ max: 12 }),
    code: text(),
    note: text(),
  },
  invariants: (c) => [
    invariant('sgv_order_ref_shape', c.orderRef.matches(/^ORD-\d{4}$/)),
    invariant('sgv_code_shape', c.code.trimmed().matches(/^[A-Z]{2}'\d$/i)),
    // Not a pattern: an `iff` over two rules, which the reader must skip rather than misread.
    invariant('sgv_note_iff', iff(c.note.isNull(), c.code.isNull())),
  ],
});

/** A whole row for a rule's type; each rule here reads its own column alone. */
const BLANK = { id: '', orderRef: '', code: '', note: '' };

const column = (property: keyof typeof orders.$columns): SeedColumn =>
  orders.$columns[property] as SeedColumn;

describe('a matches() pattern', () => {
  test('the declared pattern is read back from its CHECK, per property', () => {
    const patterns = declaredPatterns(orders);
    expect(patterns.get('orderRef')?.map(String)).toEqual([String(/^ORD-\d{4}$/)]);
    expect(patterns.get('code')?.map(String)).toEqual([String(/^[A-Z]{2}'\d$/i)]);
    expect(patterns.has('note')).toBe(false);
  });

  test('a CHECK of any other shape, or on another column, is no pattern', () => {
    expect(patternOfCheck("ref ~ '^a$'", 'other')).toBeUndefined();
    expect(patternOfCheck('ref is not null', 'ref')).toBeUndefined();
    expect(patternOfCheck("ref ~ 'a' or ref ~ 'b'", 'ref')).toBeUndefined();
    expect(patternOfCheck("ref ~ E'^\\\\d+$'", 'ref')?.source).toBe('^\\d+$');
  });

  test('without the pattern no candidate keeps the rule; with it, one does', () => {
    const rule = orders.$invariants.find((i) => i.name === 'sgv_order_ref_shape');
    const keeps = (value: unknown) =>
      typeof value === 'string' && rule?.holds({ ...BLANK, orderRef: value }) === true;
    expect(candidatesFor('orderRef', column('orderRef'), ctx()).some(keeps)).toBe(false);
    const patterns = declaredPatterns(orders).get('orderRef');
    const offered = candidatesFor('orderRef', column('orderRef'), ctx(patterns));
    expect(offered.filter(keeps).length).toBeGreaterThan(0);
  });

  test('a case-insensitive pattern over a trimmed column, quote included, is met', () => {
    const rule = orders.$invariants.find((i) => i.name === 'sgv_code_shape');
    const offered = candidatesFor(
      'code',
      column('code'),
      ctx(declaredPatterns(orders).get('code')),
    );
    expect(
      offered.some(
        (value) => typeof value === 'string' && rule?.holds({ ...BLANK, code: value }) === true,
      ),
    ).toBe(true);
  });

  test('the same row draws the same values', () => {
    const patterns = declaredPatterns(orders).get('orderRef');
    expect(candidatesFor('orderRef', column('orderRef'), ctx(patterns))).toEqual(
      candidatesFor('orderRef', column('orderRef'), ctx(patterns)),
    );
  });
});

describe('a json(schema) column', () => {
  const schema = t.object({ seats: t.number.int().min(1), plan: t.enum(['free', 'pro']) });
  const withSchema = json(schema) as SeedColumn;

  test('a value the schema accepts is offered, where {} and [] alone were refused', () => {
    const [first] = candidatesFor('settings', withSchema, ctx());
    expect(first).toMatchObject({ seats: expect.any(Number), plan: expect.any(String) });
    expect(() => withSchema.$parse({})).toThrow();
  });

  test('the same row draws the same value; another row draws another', () => {
    expect(candidatesFor('settings', withSchema, ctx())).toEqual(
      candidatesFor('settings', withSchema, ctx()),
    );
    const other = { ...ctx(), canary: 'ffeeddccbb' };
    expect(candidatesFor('settings', withSchema, other)[0]).not.toEqual(
      candidatesFor('settings', withSchema, ctx())[0],
    );
  });

  // `t.json()` accepts JSON `null`, and the sampler draws it for a `json` node; the driver binds a
  // JSON `null` as SQL NULL (`pg-row.ts` `bindable`), so a NOT NULL column's seed insert failed.
  test('a NOT NULL json(t.json()) column is never offered null; a nullable one still is', () => {
    const anyJson = json(t.json()) as SeedColumn;
    expect(anyJson.$meta.notNull).toBe(true);
    const offered = candidatesFor('payload', anyJson, ctx());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(null);
    const nullable = json(t.json()).nullable() as SeedColumn;
    expect(candidatesFor('payload', nullable, ctx())).toContain(null);
  });

  test('a jsonb column with no schema still offers {} and []', () => {
    const { schema: _schema, ...meta } = withSchema.$meta;
    const bare: SeedColumn = { $meta: meta, $parse: (value) => value };
    expect(candidatesFor('settings', bare, ctx())).toEqual([{}, []]);
  });
});
