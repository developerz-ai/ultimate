// The page byte bound: what a page weighs before a row is decoded, and the refusal past it — which
// names the heaviest column, `select()` and a `limit()` that fits, so the fix is one edit.

import { afterAll, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { bytes, json } from './columns-data';
import { entity } from './entity';
import { assertPageBytes, MAX_PAGE_BYTES, pageBytes } from './page-bytes';
import { clearRegistry } from './registry';

const docs = entity('page_bytes_docs', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    bodyJson: json(t.record(t.string)),
    blob: bytes(),
  },
});

afterAll(() => clearRegistry());

const refusalOf = (run: () => void): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return expect.unreachable('the page was answered past its byte bound');
};

describe('pageBytes', () => {
  test('counts strings by length, binary by byteLength, scalars at 8, json walked', () => {
    expect(pageBytes([{ a: 'abcd' }], Number.MAX_SAFE_INTEGER)).toBe(4);
    expect(pageBytes([{ a: new Uint8Array(100) }], Number.MAX_SAFE_INTEGER)).toBe(100);
    expect(pageBytes([{ a: 1, b: null, c: new Date(0), d: true }], Number.MAX_SAFE_INTEGER)).toBe(
      32,
    );
    // An object counts its keys and an 8-byte header; an array its header and items.
    expect(pageBytes([{ a: { xy: 'abc' } }], Number.MAX_SAFE_INTEGER)).toBe(8 + 2 + 3);
    expect(pageBytes([{ a: ['ab', 'cd'] }], Number.MAX_SAFE_INTEGER)).toBe(8 + 4);
  });

  test('stops counting past stopAt, so a cyclic value still ends', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(pageBytes([{ a: cyclic }], 1_000)).toBeGreaterThan(1_000);
  });
});

describe('assertPageBytes', () => {
  test('a page under the bound is answered', () => {
    expect(() => assertPageBytes(docs, 'findMany', [{ id: 'a', title: 'x' }], 100)).not.toThrow();
  });

  test('past the bound: X_ENTITY_PAGE_TOO_LARGE naming the heaviest column, select() and a limit', () => {
    const rows = Array.from({ length: 10 }, (_, at) => ({
      id: `id-${at}`,
      title: 'short',
      body_json: { text: 'x'.repeat(1_000) },
    }));
    const error = refusalOf(() => assertPageBytes(docs, 'findMany', rows, 5_000));
    expect(error).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
    const { cause, fix } = error as { cause: string; fix: string };
    // The physical name maps back to the property the author declared.
    expect(cause).toContain("'bodyJson'");
    expect(cause).toContain('page_bytes_docs.findMany()');
    expect(fix).toContain('.select({ id: true, title: true, blob: true })');
    // ~1,020 bytes a row against 5,000: four rows fit.
    expect(fix).toContain('.limit(4)');
  });

  test('the refusal stays bounded: a cyclic cell is refused, never walked forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const error = refusalOf(() =>
      assertPageBytes(docs, 'findMany', [{ body_json: cyclic }], 1_000),
    );
    expect(error).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
  });

  test('the default bound is MAX_PAGE_BYTES, 64 MiB', () => {
    expect(MAX_PAGE_BYTES).toBe(64 * 1024 * 1024);
    const heavy = [{ id: 'a', title: 'x'.repeat(MAX_PAGE_BYTES) }];
    expect(refusalOf(() => assertPageBytes(docs, 'findMany', heavy))).toMatchObject({
      code: 'X_ENTITY_PAGE_TOO_LARGE',
    });
    expect(() =>
      assertPageBytes(docs, 'findMany', [{ id: 'a', title: 'x'.repeat(MAX_PAGE_BYTES - 64) }]),
    ).not.toThrow();
  });
});
