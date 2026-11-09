// The statement-stack opt-in: off by default (production never pays for a stack), on while any
// holder has it, and a capture only while on.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  callerStack,
  captureStatementStacks,
  resetStatementStacks,
  statementStacksCaptured,
} from './instrument-stacks';

afterEach(resetStatementStacks);

describe('captureStatementStacks', () => {
  test('is off by default, and off captures nothing', () => {
    expect(statementStacksCaptured()).toBe(false);
    expect(callerStack()).toBeUndefined();
  });

  test('on, a capture points at the line that asked, and leaves itself out', () => {
    const release = captureStatementStacks();
    const stack = callerStack();
    expect(stack).toContain('instrument-stacks.test.ts:');
    expect(stack).not.toContain('instrument-stacks.ts:');
    release();
    expect(statementStacksCaptured()).toBe(false);
  });

  test('is ref-counted: it stays on until the last holder releases, and a release is idempotent', () => {
    const outer = captureStatementStacks();
    const inner = captureStatementStacks();
    inner();
    inner();
    expect(statementStacksCaptured()).toBe(true);
    outer();
    expect(statementStacksCaptured()).toBe(false);
  });
});
