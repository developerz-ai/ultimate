// The failure modes first, because they are the reason this module exists: "No results" rendered
// while the first page is still in flight, and a refetch that tears the current page down to a
// skeleton. Both are decisions, so both are pinned here rather than reviewed per screen.

import { describe, expect, test } from 'bun:test';
import {
  type AsyncState,
  asyncBranch,
  asyncStateOf,
  isBusyBranch,
  isEmptyData,
  reserveBlockSize,
} from './async-branch';

const rows = ['a', 'b'];

describe('asyncBranch, the states that must not be confusable', () => {
  test('pending is never empty — a first page in flight is not "no results"', () => {
    // The state carries no data at all, so there is nothing to find empty: the type is the
    // enforcement and this is the behaviour that follows from it.
    expect(asyncBranch<readonly string[]>({ status: 'pending' })).toEqual({ kind: 'pending' });
  });

  test('a refetch keeps the previous data on screen, marked busy', () => {
    expect(asyncBranch({ status: 'refreshing', data: rows })).toEqual({
      kind: 'ready',
      data: rows,
      busy: true,
    });
  });

  test('empty is reachable only from a completed result that returned zero', () => {
    expect(asyncBranch({ status: 'ready', data: [] })).toEqual({ kind: 'empty', busy: false });
    // A refetch OVER a completed empty result stays empty rather than flashing a skeleton: the
    // user already read "no results", and replacing it is a second layout change for no news.
    expect(asyncBranch({ status: 'refreshing', data: [] })).toEqual({ kind: 'empty', busy: true });
  });

  test('a settled result renders its data with no busy flag', () => {
    expect(asyncBranch({ status: 'ready', data: rows })).toEqual({
      kind: 'ready',
      data: rows,
      busy: false,
    });
  });

  test('a failure beats stale data — the rows on screen did not answer the request that failed', () => {
    const error = { code: 'X_INTERNAL' };
    expect(asyncBranch({ status: 'failed', error })).toEqual({ kind: 'failed', error });
  });

  test('a caller’s own emptiness test decides for an envelope shape', () => {
    const envelope = { total: 0, items: [] as readonly string[] };
    expect(asyncBranch({ status: 'ready', data: envelope }).kind).toBe('ready');
    expect(asyncBranch({ status: 'ready', data: envelope }, (d) => d.items.length === 0).kind).toBe(
      'empty',
    );
  });
});

describe('isEmptyData', () => {
  test('nothing at all, and every container with no entries', () => {
    for (const value of [null, undefined, [], new Map(), new Set(), '']) {
      expect(isEmptyData(value)).toBe(true);
    }
  });

  test('anything else is data — 0 and false are answers, not absences', () => {
    for (const value of [0, false, {}, ['x'], new Map([['a', 1]])]) {
      expect(isEmptyData(value)).toBe(false);
    }
  });
});

describe('isBusyBranch', () => {
  test('pending is busy, a failure never is, and the rest report their own flag', () => {
    expect(isBusyBranch({ kind: 'pending' })).toBe(true);
    expect(isBusyBranch({ kind: 'failed', error: 'x' })).toBe(false);
    expect(isBusyBranch({ kind: 'empty', busy: true })).toBe(true);
    expect(isBusyBranch({ kind: 'ready', data: rows, busy: false })).toBe(false);
  });
});

describe('asyncStateOf, the flag-shaped source a resource already is', () => {
  test('loading with nothing yet is pending, so the empty branch stays unreachable', () => {
    expect(asyncStateOf({ loading: true })).toEqual({ status: 'pending' });
  });

  test('loading with a previous value is a refetch, and the value survives it', () => {
    expect(asyncStateOf({ loading: true, data: rows })).toEqual({
      status: 'refreshing',
      data: rows,
    });
  });

  test('an empty array IS data — that is what makes "no results" reachable at all', () => {
    const state: AsyncState<readonly string[]> = asyncStateOf<readonly string[]>({ data: [] });
    expect(state).toEqual({ status: 'ready', data: [] });
    expect(asyncBranch(state).kind).toBe('empty');
  });

  test('an error wins over both, however much data is held', () => {
    expect(asyncStateOf({ loading: true, data: rows, error: 'boom' })).toEqual({
      status: 'failed',
      error: 'boom',
    });
  });

  test('a settled resource with no error and no reload is ready', () => {
    expect(asyncStateOf({ loading: false, data: rows })).toEqual({ status: 'ready', data: rows });
  });
});

describe('reserveBlockSize', () => {
  test('is the skeleton’s own box, so the loaded content cannot land in a different one', () => {
    expect(reserveBlockSize({ lines: 5, height: '1.1em' })).toBe('calc(5 * 1.1em)');
  });

  test('defaults to the same line height Skeleton does', () => {
    expect(reserveBlockSize({ lines: 3 })).toBe('calc(3 * 1em)');
  });
});
