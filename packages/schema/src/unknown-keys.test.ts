// Pins the walker #1281's warning reads: which keys a value carries that its schema never declared,
// and — for unions — which arm gets to say what is declared.

import { describe, expect, test } from 'bun:test';
import { MAX_ISSUES } from './issue-cap';
import type { SchemaNode } from './node';
import { unknownKeys } from './unknown-keys';
import { builtinT as t } from './validators';

const page = t.object({ limit: t.number, after: t.string.optional() });

describe('unknownKeys', () => {
  test('a value with only declared keys has none', () => {
    expect(unknownKeys(page.node, { limit: 1, after: 'x' })).toEqual([]);
  });

  test('a top-level key the object does not declare is named with the keys it does', () => {
    expect(unknownKeys(page.node, { limt: 1, offset: 5 })).toEqual([
      { path: 'limt', key: 'limt', declared: ['limit', 'after'] },
      { path: 'offset', key: 'offset', declared: ['limit', 'after'] },
    ]);
  });

  test('nested objects and array items are walked, with the full path', () => {
    const schema = t.object({
      filter: t.object({ status: t.string }),
      lines: t.array(t.object({ sku: t.string, qty: t.number })),
    });
    const value = {
      filter: { status: 'open', stauts: 'x' },
      lines: [{ sku: 'a', qty: 1, qyt: 2 }],
    };
    expect(unknownKeys(schema.node, value)).toEqual([
      { path: 'filter.stauts', key: 'stauts', declared: ['status'] },
      { path: 'lines[0].qyt', key: 'qyt', declared: ['sku', 'qty'] },
    ]);
  });

  test('records, JSON and money values are skipped: their keys are the caller’s', () => {
    const schema = t.object({
      tags: t.record(t.string),
      blob: t.json(),
      price: t.money,
    });
    const value = {
      tags: { anything: 'goes' },
      blob: { free: { form: 1 } },
      price: { minor: 100, currency: 'EUR' },
    };
    expect(unknownKeys(schema.node, value)).toEqual([]);
  });

  test('a discriminated union walks only the arm its discriminant selects', () => {
    const post = t.object({ kind: t.literal('post'), slug: t.string });
    const doc = t.object({ kind: t.literal('page'), title: t.string });
    const schema = t.discriminatedUnion('kind', post, doc);
    // `title` is declared — by the sibling arm, which this value did not select.
    expect(unknownKeys(schema.node, { kind: 'post', slug: 'a', title: 'b' })).toEqual([
      { path: 'title', key: 'title', declared: ['kind', 'slug'] },
    ]);
    expect(unknownKeys(schema.node, { kind: 'page', title: 'b' })).toEqual([]);
  });

  test('a plain union reports a key only when no arm declares it', () => {
    const schema = t.union(t.object({ a: t.string }), t.object({ b: t.string }));
    expect(unknownKeys(schema.node, { a: 'x', b: 'y' })).toEqual([]);
    expect(unknownKeys(schema.node, { a: 'x', c: 'z' })).toEqual([
      { path: 'c', key: 'c', declared: ['a', 'b'] },
    ]);
  });

  test('a plain union with an open arm reports nothing at that level', () => {
    const schema = t.union(t.object({ a: t.string }), t.record(t.string));
    expect(unknownKeys(schema.node, { a: 'x', c: 'z' })).toEqual([]);
  });

  test('a plain union walks into a key every declaring arm shares', () => {
    const schema = t.union(
      t.object({ meta: t.object({ x: t.string }) }),
      t.object({ meta: t.object({ y: t.string }) }),
    );
    expect(unknownKeys(schema.node, { meta: { x: '1', y: '2', z: '3' } })).toEqual([
      { path: 'meta.z', key: 'z', declared: ['x', 'y'] },
    ]);
  });

  test('optional and nullable members that are absent or null are not walked', () => {
    const schema = t.object({ inner: t.object({ a: t.string }).optional() });
    expect(unknownKeys(schema.node, {})).toEqual([]);
    expect(unknownKeys(schema.node, { inner: undefined })).toEqual([]);
  });

  test('an object node with no declared properties is open, never "every key unknown"', () => {
    const open: SchemaNode = { kind: 'object' };
    expect(unknownKeys(open, { a: 1 })).toEqual([]);
  });

  test('a non-object value at an object node reports nothing — the parse already judged it', () => {
    expect(unknownKeys(page.node, 'x')).toEqual([]);
    expect(unknownKeys(page.node, null)).toEqual([]);
  });

  test('the answer stops at MAX_ISSUES, however many keys a hostile input carries', () => {
    const value: Record<string, number> = {};
    for (let i = 0; i < MAX_ISSUES * 3; i += 1) value[`k${i}`] = i;
    expect(unknownKeys(page.node, value)).toHaveLength(MAX_ISSUES);
  });
});
