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
