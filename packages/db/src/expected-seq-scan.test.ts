// `expectedSeqScan(reason, fn)`: the one way a hand-written statement says it must read its table
// whole. The scope carries the reason across awaits, the innermost wins, and it is a different
// argument from `expectedQueryLoop`'s — one never answers for the other.

import { describe, expect, test } from 'bun:test';
import {
  expectedQueryLoop,
  expectedQueryLoopReason,
  expectedSeqScan,
  expectedSeqScanReason,
} from './expected-loop';

const REASON = 'the nightly report reads every row once';

describe('unit · expectedSeqScan', () => {
  test('a blank reason is refused', () => {
    expect(() => expectedSeqScan('  ', () => 1)).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });

  test('the reason is in force across awaits, and gone after the scope', async () => {
    expect(expectedSeqScanReason()).toBeUndefined();
    const seen = await expectedSeqScan(REASON, async () => {
      await Promise.resolve();
      return expectedSeqScanReason();
    });
    expect(seen).toBe(REASON);
    expect(expectedSeqScanReason()).toBeUndefined();
  });

  test('the innermost scope is the one in force', () => {
    const inner = expectedSeqScan('outer', () => expectedSeqScan('inner', expectedSeqScanReason));
    expect(inner).toBe('inner');
  });

  test('a loop reason is not a scan reason, nor the other way round', () => {
    expect(expectedQueryLoop('a loop', expectedSeqScanReason)).toBeUndefined();
    expect(expectedSeqScan('a scan', expectedQueryLoopReason)).toBeUndefined();
  });
});
