// The cost of a VALID composite, pinned as work, never wall time: a builtin member was validated
// through its public `'~standard'.validate` — a cap closure, a run record, a result, a re-wrap and
// a fresh path per member — so a 5-field object cost 4.6 µs and 10k of them 47 ms of sync CPU.

import { describe, expect, test } from 'bun:test';
import { type AnySchema, makeSchema, type Path, pass } from './builder';
import { type StandardSchemaV1, validate } from './standard';
import { t } from './t';

const ITEMS = 10_000;

/** Counts every call of `schema`'s public validate, keeping the schema itself the same object. */
function countValidate(schema: AnySchema): { readonly calls: () => number } {
  const props = schema['~standard'] as { validate: StandardSchemaV1['~standard']['validate'] };
  const real = props.validate;
  let calls = 0;
  props.validate = (value) => {
    calls += 1;
    return real(value);
  };
  return { calls: () => calls };
}

describe('10k valid objects', () => {
  test('a builtin member is checked directly: its public validate is never called', () => {
    const id = t.number;
    const name = t.string.min(1);
    const tags = t.array(t.string);
    const counters = [id, name, tags].map(countValidate);
    const row = t.object({ id, name, tags, at: t.record(t.boolean), kind: t.enum(['a', 'b']) });
    const rows = Array.from({ length: ITEMS }, (_, n) => ({
      id: n,
      name: 'x',
      tags: ['a'],
      at: { on: true },
      kind: 'a',
    }));
    expect(validate(t.array(row), rows).issues).toBeUndefined();
    expect(counters.map((counter) => counter.calls())).toEqual([0, 0, 0]);
  });

  test('a passing member allocates no path: every call shares one', () => {
    const seen = new Set<Path>();
    const member = makeSchema<number, number>({ kind: 'number' }, (value, path) => {
      seen.add(path);
      return pass(value as number);
    });
    const row = t.object({ a: member, b: t.array(member), c: t.record(member) });
    const rows = Array.from({ length: ITEMS }, (_, n) => ({ a: n, b: [n], c: { k: n } }));
    expect(validate(t.array(row), rows).issues).toBeUndefined();
    // Before: `[...path, key]` per field, `[...path, index]` per item — 30k distinct arrays.
    expect(seen.size).toBe(1);
  });

  test('a foreign Standard Schema member still goes through its public validate', () => {
    let calls = 0;
    const foreign: StandardSchemaV1<number, number> = {
      '~standard': {
        version: 1,
        vendor: 'foreign',
        validate: (value) => {
          calls += 1;
          return typeof value === 'number' ? { value } : { issues: [{ message: 'nope' }] };
        },
      },
    };
    const row = t.object({ n: foreign as unknown as AnySchema });
    const rows = Array.from({ length: ITEMS }, (_, n) => ({ n }));
    expect(validate(t.array(row), rows).issues).toBeUndefined();
    expect(calls).toBe(ITEMS);
  });
});

describe('a failure still names the whole path, built only then', () => {
  test('nested object, array and record members re-root to the full path, in order', () => {
    const schema = t.object({
      rows: t.array(t.object({ n: t.number, meta: t.record(t.string.min(2)) })),
    });
    const result = validate(schema, {
      rows: [
        { n: 1, meta: { a: 'ok' } },
        { n: 'x', meta: { a: 'ok', b: 'y' } },
      ],
    });
    expect(result.issues?.map((issue) => issue.path)).toEqual([
      ['rows', 1, 'n'],
      ['rows', 1, 'meta', 1],
    ]);
    expect(result.issues?.map((issue) => issue.rule)).toEqual(['type', 'string.min']);
  });

  test('a foreign member failing is re-rooted once, its rule kept', () => {
    const foreign: StandardSchemaV1<number, number> = {
      '~standard': {
        version: 1,
        vendor: 'foreign',
        validate: () => ({ issues: [{ message: 'nope', path: ['inner'] }] }),
      },
    };
    const schema = t.object({ list: t.array(foreign as unknown as AnySchema) });
    const result = validate(schema, { list: [1] });
    expect(result.issues).toEqual([{ message: 'nope', path: ['list', 0, 'inner'] }]);
  });

  test('a refinement path under a member keeps its own segments', () => {
    const range = t.object({ from: t.number, to: t.number }).refine({
      name: 'to-after-from',
      message: 'to must be after from',
      check: (value) => value.to > value.from,
      path: ['to'],
    });
    const result = validate(t.object({ range }), { range: { from: 2, to: 1 } });
    expect(result.issues?.[0]?.path).toEqual(['range', 'to']);
  });
});
