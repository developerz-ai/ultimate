// Layer 4 apart from the tool: what a `limit` argument is allowed to do, and what happens when
// a read is bigger than the answer is allowed to be. Truncation that is not reported is the
// same bug as no cap at all — the agent reasons on a slice it believes is the whole table.

import { describe, expect, test } from 'bun:test';
import type { QueryRows } from './query-limits';
import { capQueryRows, DEFAULT_QUERY_ROWS, QUERY_LIMITS, resolveQueryLimits } from './query-limits';

const rowsOf = (count: number, cell: unknown = 1): QueryRows => ({
  columns: ['n'],
  rows: Array.from({ length: count }, () => [cell]),
  guards: ['txn:read-only'],
});

describe('resolveQueryLimits treats `limit` as a request, never a permission', () => {
  test('no argument means the default, well under the ceiling', () => {
    expect(resolveQueryLimits(undefined).maxRows).toBe(DEFAULT_QUERY_ROWS);
    expect(DEFAULT_QUERY_ROWS).toBeLessThan(QUERY_LIMITS.maxRows);
  });

  test('a bigger ask is clamped to the ceiling, not honoured', () => {
    expect(resolveQueryLimits(10_000).maxRows).toBe(QUERY_LIMITS.maxRows);
    expect(resolveQueryLimits(Number.MAX_SAFE_INTEGER).maxRows).toBe(QUERY_LIMITS.maxRows);
  });

  test('zero, negative, fractional and non-numeric asks never widen anything', () => {
    expect(resolveQueryLimits(0).maxRows).toBe(1);
    expect(resolveQueryLimits(-5).maxRows).toBe(1);
    expect(resolveQueryLimits(7.9).maxRows).toBe(7);
    expect(resolveQueryLimits('1000000').maxRows).toBe(DEFAULT_QUERY_ROWS);
    expect(resolveQueryLimits(Number.POSITIVE_INFINITY).maxRows).toBe(DEFAULT_QUERY_ROWS);
  });

  test('the byte and timeout ceilings are not negotiable from an argument', () => {
    const limits = resolveQueryLimits(1);
    expect(limits.maxBytes).toBe(QUERY_LIMITS.maxBytes);
    expect(limits.timeoutMs).toBe(QUERY_LIMITS.timeoutMs);
  });
});

describe('capQueryRows reports every cut it makes', () => {
  const limits = resolveQueryLimits(10);

  test('a result inside both ceilings is untruncated and keeps the host guards', () => {
    const result = capQueryRows(rowsOf(3), limits);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeNull();
    expect(result.guards).toEqual(['txn:read-only', 'cap:10 rows', 'cap:262144 bytes']);
  });

  test('the n+1 row the host fetched is dropped and reported, never returned', () => {
    const result = capQueryRows(rowsOf(11), limits);
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('rows');
  });

  test('the byte ceiling bites before the row ceiling and says so', () => {
    const fat = { ...rowsOf(10, 'x'.repeat(200)), guards: [] };
    const tight = { ...limits, maxBytes: 700 };
    const result = capQueryRows(fat, tight);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.rowCount).toBeLessThan(10);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.bytes).toBeLessThanOrEqual(700);
  });

  test('one row larger than the whole ceiling yields no rows rather than blowing the cap', () => {
    const huge = { ...rowsOf(1, 'x'.repeat(5_000)), guards: [] };
    const result = capQueryRows(huge, { ...limits, maxBytes: 512 });
    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.bytes).toBeLessThanOrEqual(512);
  });

  test('`bytes` counts what is returned and never under-counts it', () => {
    const result = capQueryRows(rowsOf(4), limits);
    const actual = new TextEncoder().encode(JSON.stringify(result.rows)).length;
    // Every row is charged its own separator, so the tally is conservative by exactly the row
    // count. A cap that rounds the other way is a cap that can be exceeded.
    expect(result.bytes).toBeGreaterThanOrEqual(actual);
    expect(result.bytes).toBeLessThanOrEqual(actual + result.rowCount);
  });

  test('columns survive an empty result, so the shape is readable with no rows', () => {
    const result = capQueryRows({ columns: ['id', 'title'], rows: [], guards: [] }, limits);
    expect(result.columns).toEqual(['id', 'title']);
    expect(result.truncated).toBe(false);
  });
});
