import { describe, expect, test } from 'bun:test';
import { coerceInput, coerceNode, coerceQuery } from './coerce';
import { parse, validate } from './standard';
import { t } from './t';

const listPosts = t.object({
  page: t.number.int().default(1),
  live: t.boolean.default(false),
  tags: t.array(t.slug),
  since: t.optional(t.date),
});

describe('coerceQuery', () => {
  test('an Object.prototype member is never read as a submitted value', () => {
    // A schema is allowed to declare a field called `toString` — a client that never sent one
    // must not have the INHERITED member coerced in as if it had, and a function must never
    // reach validation as a value the caller supplied.
    const input = t.object({
      toString: t.optional(t.string),
      valueOf: t.optional(t.number),
      constructor: t.optional(t.string),
      page: t.number.int().default(1),
    });

    const fromSearchParams = coerceQuery(input, new URLSearchParams('page=2'));
    const fromRecord = coerceQuery(input, { page: '2' });

    for (const coerced of [fromSearchParams, fromRecord]) {
      expect(Object.hasOwn(coerced, 'toString')).toBe(false);
      expect(Object.hasOwn(coerced, 'valueOf')).toBe(false);
      expect(Object.hasOwn(coerced, 'constructor')).toBe(false);
      expect(coerced['page']).toBe(2);
    }
  });

  test("coerceNode's object branch coerces own properties only", () => {
    const node = t.object({ toString: t.optional(t.string), n: t.optional(t.number) }).node;
    const coerced = coerceNode(node, { n: '2' }) as Record<string, unknown>;

    // `{ ...source }` already drops what a prototype carries; the `in` check put it back.
    expect(Object.hasOwn(coerced, 'toString')).toBe(false);
    expect(coerced['n']).toBe(2);
  });

  test('a __proto__ query key is data, not a prototype swap', () => {
    const input = t.object({ page: t.number.int().default(1) });
    const coerced = coerceQuery(input, new URLSearchParams('__proto__=polluted&page=2'));

    expect(Object.getOwnPropertyDescriptor(coerced, '__proto__')?.value).toBe('polluted');
    expect(coerced['page']).toBe(2);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  test('a DECLARED __proto__ field is coerced like any other, now the IR carries it', () => {
    // The other half of the same defect: while `objectSchema` dropped the key from
    // `node.properties`, this loop had nothing to walk and the field arrived as the raw string.
    const input = t.object({ ['__proto__']: t.number.int() });
    const coerced = coerceQuery(input, new URLSearchParams('__proto__=7'));
    expect(Object.getOwnPropertyDescriptor(coerced, '__proto__')?.value).toBe(7);
    expect(Object.hasOwn(Object.prototype, '7')).toBe(false);
  });

  test('turns a query string into something the schema accepts', () => {
    const query = new URLSearchParams('page=3&live=yes&tags=alpha&tags=beta&since=2026-07-26');
    const coerced = coerceQuery(listPosts, query);

    expect(coerced['page']).toBe(3);
    expect(coerced['live']).toBe(true);
    expect(coerced['tags']).toEqual(['alpha', 'beta']);
    expect(coerced['since']).toBeInstanceOf(Date);

    const parsed = parse(listPosts, coerced);
    expect(parsed.page).toBe(3);
    expect(parsed.tags).toEqual(['alpha', 'beta']);
  });

  test('leaves a zone-less date-time a string, so validation states the real refusal', () => {
    // The one path where a caller's string reaches `t.date`. Converted here it would resolve
    // through the container's `TZ`: `?since=2026-08-19T10:00` is 14:00Z on one pod, 10:00Z on
    // the next, and the two would agree only by accident.
    const coerced = coerceQuery(listPosts, new URLSearchParams('since=2026-08-19T10:00'));
    expect(coerced['since']).toBe('2026-08-19T10:00');
    const issues = validate(listPosts, coerced).issues ?? [];
    expect(issues.map((issue) => issue.message).join(' | ')).toContain('an offset or Z');
  });

  test('an instant that names its own zone is coerced to a Date', () => {
    const coerced = coerceQuery(listPosts, new URLSearchParams('since=2026-08-19T10:00:00Z'));
    expect(coerced['since']).toBeInstanceOf(Date);
    expect((coerced['since'] as Date).toISOString()).toBe('2026-08-19T10:00:00.000Z');
  });

  test('promotes a single repeated param into an array', () => {
    const coerced = coerceQuery(listPosts, new URLSearchParams('tags=solo'));
    expect(coerced['tags']).toEqual(['solo']);
  });

  test('leaves values it cannot convert alone so validation reports the real error', () => {
    const coerced = coerceQuery(listPosts, { page: 'abc', live: 'maybe', tags: ['ok'] });
    expect(coerced['page']).toBe('abc');
    expect(coerced['live']).toBe('maybe');
    expect(() => parse(listPosts, coerced)).toThrow(/X_VALIDATION_FAILED/);
  });

  test('coercion is opt-in: parse alone still rejects strings', () => {
    expect(() => parse(listPosts, { page: '3', tags: [] })).toThrow(/X_VALIDATION_FAILED/);
  });

  test('coerceNode handles money and nested objects', () => {
    expect(coerceNode(t.money.node, { minor: '1999', currency: 'EUR' })).toEqual({
      minor: 1999,
      currency: 'EUR',
    });
    // A blank field is an amount nobody typed. `Number('')` is 0, so converting it would hand
    // validation a legitimate-looking zero and book an empty price input as free.
    expect(coerceNode(t.money.node, { minor: '', currency: 'USD' })).toEqual({
      minor: '',
      currency: 'USD',
    });
    // A query string carries every field as text, scale included — leaving it a string would
    // fail validation on a value the same request's `minor` was accepted for.
    expect(coerceNode(t.money.node, { minor: '2', currency: 'USD', scale: '6' })).toEqual({
      minor: 2,
      currency: 'USD',
      scale: 6,
    });
    const nested = t.object({ page: t.number, inner: t.object({ live: t.boolean }) });
    expect(coerceInput(nested, { page: '2', inner: { live: 'true' } })).toEqual({
      page: 2,
      inner: { live: true },
    });
  });

  test('a numeric or boolean literal is reachable over its own GET route', () => {
    // `literal` fell through to `default: return raw`, so `t.literal(2)` received `"2"` and
    // `literalSchema` compares with `===` — the endpoint 400d on every request, while the same
    // declaration worked over an action's JSON body and over MCP.
    const input = t.object({ version: t.literal(2), beta: t.literal(true) });
    const coerced = coerceQuery(input, new URLSearchParams('version=2&beta=true'));
    expect(coerced['version']).toBe(2);
    expect(coerced['beta']).toBe(true);
    expect(parse(input, coerced)).toEqual({ version: 2, beta: true });
  });

  test('a union of numeric literals coerces through its members', () => {
    const input = t.object({ version: t.union(t.literal(1), t.literal(2)) });
    expect(parse(input, coerceQuery(input, new URLSearchParams('version=2')))).toEqual({
      version: 2,
    });
  });

  test('a string literal is left alone, and a non-numeric value still reaches validation', () => {
    const input = t.object({ kind: t.literal('post'), version: t.literal(2) });
    const coerced = coerceQuery(input, new URLSearchParams('kind=post&version=abc'));
    expect(coerced['kind']).toBe('post');
    expect(coerced['version']).toBe('abc');
  });

  test('a record key that reaches Object.prototype survives to be REFUSED', () => {
    // `out[key] = …` on a `{}` literal hit the prototype setter, so `__proto__` vanished before
    // `recordSchema`'s deliberate refusal of it could run: reported as absent, never as rejected.
    const record = t.record(t.string);
    const coerced = coerceNode(record.node, JSON.parse('{"a":"b","__proto__":"x"}'));
    expect(Object.keys(coerced as object)).toEqual(['a', '__proto__']);
    expect(() => parse(record, coerced)).toThrow(/X_VALIDATION_FAILED/);
  });
});

describe('coerceNode never invents data', () => {
  test('an array is not an object: it reaches validation as the array it is', () => {
    // `{ ...['x'] }` is `{ 0: 'x' }`, which an all-optional object schema then accepted as `{}`.
    const input = t.object({ a: t.number.optional() });
    const coerced = coerceInput(input, ['x'] as unknown as Record<string, unknown>);
    expect(Array.isArray(coerced)).toBe(true);
    expect(validate(input, coerced).issues).toBeDefined();
    expect(coerceNode(input.node, ['x'])).toEqual(['x']);
  });

  test('an array is not a record or a money value either', () => {
    expect(coerceNode(t.record(t.number).node, ['1'])).toEqual(['1']);
    expect(Array.isArray(coerceNode(t.record(t.number).node, ['1']))).toBe(true);
    expect(Array.isArray(coerceNode(t.money.node, ['1']))).toBe(true);
  });

  test('a class instance is not spread into an empty object', () => {
    const when = new Date(0);
    expect(coerceNode(t.object({ a: t.number.optional() }).node, when)).toBe(when);
    const map = new Map([['a', '1']]);
    expect(coerceNode(t.record(t.number).node, map)).toBe(map);
  });

  test('only a DECIMAL numeral is a number: hex, octal and binary stay text', () => {
    for (const raw of ['0x10', '0b11', '0o17', '0X1F', '1_000', 'Infinity', '1e', '.', '+', '']) {
      expect(coerceNode({ kind: 'number' }, raw)).toBe(raw);
      expect(coerceNode({ kind: 'literal', literal: 16 }, raw)).toBe(raw);
    }
    expect(coerceNode(t.money.node, { minor: '0x10', currency: 'EUR' })).toEqual({
      minor: '0x10',
      currency: 'EUR',
    });
    expect(coerceNode({ kind: 'number' }, '16')).toBe(16);
    expect(coerceNode({ kind: 'number' }, '-1.5')).toBe(-1.5);
    expect(coerceNode({ kind: 'number' }, '.5')).toBe(0.5);
    expect(coerceNode({ kind: 'number' }, '1e3')).toBe(1000);
    expect(coerceNode({ kind: 'number' }, ' 12 ')).toBe(12);
  });

  test('every union member is tried, not only the first', () => {
    const mixed = t.object({ size: t.union(t.literal('auto'), t.literal(2)) });
    expect(parse(mixed, coerceQuery(mixed, new URLSearchParams('size=2')))).toEqual({ size: 2 });
    expect(parse(mixed, coerceQuery(mixed, new URLSearchParams('size=auto')))).toEqual({
      size: 'auto',
    });
    const wide = t.object({ size: t.union(t.literal('auto'), t.number) });
    expect(parse(wide, coerceQuery(wide, new URLSearchParams('size=12')))).toEqual({ size: 12 });
    expect(parse(wide, coerceQuery(wide, new URLSearchParams('size=auto')))).toEqual({
      size: 'auto',
    });
  });

  test('a string a member already accepts is never converted behind its back', () => {
    // A postcode: `number | string` must not turn `01234` into 1234.
    const node = t.union(t.number, t.string).node;
    expect(coerceNode(node, '01234')).toBe('01234');
    expect(coerceNode(t.union(t.literal(1), t.literal(2)).node, 'abc')).toBe('abc');
  });

  test('a union of objects coerces through the member the value names', () => {
    const event = t.discriminatedUnion(
      'kind',
      t.object({ kind: t.literal('text'), body: t.string }),
      t.object({ kind: t.literal('count'), body: t.number }),
    );
    const coerced = coerceNode(event.node, { kind: 'count', body: '5' });
    expect(coerced).toEqual({ kind: 'count', body: 5 });
    expect(parse(event, coerced)).toEqual({ kind: 'count', body: 5 });
    expect(coerceNode(event.node, { kind: 'text', body: '5' })).toEqual({
      kind: 'text',
      body: '5',
    });
    // No member claims it: untouched, so validation names the real problem.
    const stray = { kind: 'other', body: '5' };
    expect(coerceNode(event.node, stray)).toBe(stray);
  });
});
