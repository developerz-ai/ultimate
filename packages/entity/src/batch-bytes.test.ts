// `shrinkingPages`: a page refused for its bytes is re-read at the same cursor with half the rows,
// the smaller size sticks, a single row over the bound is still refused, and any other error passes.

import { describe, expect, test } from 'bun:test';
import { type Page, pageOf } from '@ultimat3/core';
import { shrinkingPages } from './batch-bytes';
import { EntityError } from './entity-error';

const heavy = (): EntityError =>
  new EntityError({ code: 'X_ENTITY_PAGE_TOO_LARGE', cause: 'test page', fix: '.limit(1)' });

/** A reader that refuses any page over `fits` rows and records every limit it was sent. */
const reader = (fits: number) => {
  const sent: { limit: number; cursor: string | null }[] = [];
  const read = async (limit: number, cursor: string | null): Promise<Page<number>> => {
    sent.push({ limit, cursor });
    if (limit > fits) throw heavy();
    return pageOf(
      Array.from({ length: limit }, (_, at) => at),
      'next',
    );
  };
  return { sent, read };
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => expect.unreachable('the read was answered'),
    (thrown: unknown) => thrown,
  );

describe('shrinkingPages', () => {
  test('halves at the same cursor until the page fits: ⌈log2⌉ refusals, then sticks', async () => {
    const { sent, read } = reader(700);
    const page = shrinkingPages(10_000, read);
    expect((await page('c1')).rows).toHaveLength(625);
    // 10000 → 5000 → 2500 → 1250 → 625: four refused, all at the batch's own cursor.
    expect(sent.map((s) => s.limit)).toEqual([10_000, 5_000, 2_500, 1_250, 625]);
    expect(new Set(sent.map((s) => s.cursor))).toEqual(new Set(['c1']));
    // The next batch starts at the size that fit: one statement.
    await page('c2');
    expect(sent.slice(5)).toEqual([{ limit: 625, cursor: 'c2' }]);
  });

  test('a single row over the bound is still refused', async () => {
    const { sent, read } = reader(0);
    const error = await refusalOf(() => shrinkingPages(8, read)(null));
    expect(error).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
    expect(sent.map((s) => s.limit)).toEqual([8, 4, 2, 1]);
  });

  test('any other error is thrown at once, never retried', async () => {
    let calls = 0;
    const error = await refusalOf(() =>
      shrinkingPages(100, async () => {
        calls += 1;
        throw new EntityError({ code: 'X_NOT_FOUND', cause: 'test', fix: '.limit(1)' });
      })(null),
    );
    expect(error).toMatchObject({ code: 'X_NOT_FOUND' });
    expect(calls).toBe(1);
  });
});
