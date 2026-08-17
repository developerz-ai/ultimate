import { describe, expect, test } from 'bun:test';
import { coerceInput, coerceNode, coerceQuery } from './coerce';
import { parse } from './standard';
import { t } from './t';

const listPosts = t.object({
  page: t.number.int().default(1),
  live: t.boolean.default(false),
  tags: t.array(t.slug),
  since: t.optional(t.date),
});

describe('coerceQuery', () => {
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
