// The `verify` job's step summary: bounded, whatever the verdict weighs. GitHub refuses a summary
// over 1024 KiB ("upload aborted") and a red merge's document runs past that, so it was lost.

import { describe, expect, test } from 'bun:test';
import { thrownBy } from '../packages/cli/src/thrown-by-fixture';
import { renderMergeSummary, STEP_SUMMARY_CAP_BYTES } from './verify-summary';

const POINTER = 'shown {shown} of {total}; the rest: the job log';

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

const finding = (index: number, cause = `cause ${String(index)}`) => ({
  code: 'X_LINT',
  cause,
  fix: `x fix ${String(index)}`,
  at: `file-${String(index)}.ts`,
});

const doc = (steps: readonly unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: false,
    command: 'verify',
    summary: 'merged 3 part(s): 1 failed',
    steps,
    ...extra,
  });

const step = (name: string, ok: boolean, more: Record<string, unknown> = {}) => ({
  name,
  ok,
  durationMs: 12,
  skipped: false,
  findings: [],
  ...more,
});

/** A red verdict the size real ones reach: thousands of findings, megabytes of suite output. */
const hugeRed = (): string =>
  doc([
    step('lint', false, { findings: Array.from({ length: 20_000 }, (_, i) => finding(i)) }),
    step('unit', false, {
      tests: { ran: 900, skipped: 2 },
      findings: [finding(9999)],
      output: [
        '(fail) every app module > imports [12.00ms]',
        ...Array.from({ length: 40_000 }, (_, i) => `line ${String(i)} of a suite's output`),
      ].join('\n'),
    }),
    step('live', true),
  ]);

describe('unit · verify merge summary · bounded under GitHub`s cap', () => {
  test('a huge red verdict renders under the cap: every step, the first findings, the pointer', () => {
    const verdict = hugeRed();
    expect(bytes(verdict)).toBeGreaterThan(1024 * 1024);

    const summary = renderMergeSummary(verdict, 'verdict.json', POINTER);

    expect(bytes(summary)).toBeLessThanOrEqual(STEP_SUMMARY_CAP_BYTES);
    expect(STEP_SUMMARY_CAP_BYTES).toBeLessThanOrEqual(1024 * 1024 - 64 * 1024);
    for (const name of ['lint', 'unit', 'live']) expect(summary).toMatch(new RegExp(` ${name} `));
    expect(summary).toContain('✗ merged 3 part(s): 1 failed');
    expect(summary).toContain('cause: cause 0');
    expect(summary).toContain('(fail) every app module > imports');
    // The suite output is the log's, never the summary's: it is what blew the cap.
    expect(summary).not.toContain("of a suite's output");
    expect(summary).toMatch(/shown \d+ of 20001; the rest: the job log\n$/);
    expect(summary).not.toContain('{shown}');
    expect(summary).not.toContain('shown 20001 of');
  });

  test('a small verdict is whole: every finding shown, and the pointer counts them all', () => {
    const summary = renderMergeSummary(
      doc([step('lint', false, { findings: [finding(1)] }), step('unit', true)], {
        findings: [{ code: 'X_VERIFY_MERGE_INCOMPLETE', cause: 'top', fix: 'x verify merge' }],
      }),
      'verdict.json',
      POINTER,
    );
    expect(summary).toContain('cause: cause 1');
    expect(summary).toContain('cause: top');
    expect(summary).toContain('shown 2 of 2');
  });

  test('one finding past the cap on its own is clipped, never the reason nothing is shown', () => {
    const summary = renderMergeSummary(
      doc([step('lint', false, { findings: [finding(1, 'é'.repeat(800_000)), finding(2)] })]),
      'verdict.json',
      POINTER,
    );
    expect(bytes(summary)).toBeLessThanOrEqual(STEP_SUMMARY_CAP_BYTES);
    expect(summary).toContain('cause: éé');
    expect(summary).not.toContain('�');
    expect(summary).toContain('shown 2 of 2');
  });

  test('a fence in a cause cannot close the block it is quoted in', () => {
    const summary = renderMergeSummary(
      doc([step('lint', false, { findings: [finding(1, '```` and ``` inside')] })]),
      'verdict.json',
      POINTER,
    );
    // Every opener is closed by its own fence, and the quoted runs sit inside the findings block.
    const fences = summary.split('\n').filter((line) => /^`{3,}/.test(line));
    expect(fences.length).toBe(4);
    expect(fences[1]).toBe(fences[0]?.replace(/text$/, ''));
    expect(fences[3]).toBe(fences[2]?.replace(/text$/, ''));
    expect(fences[2]).toBe('`````text');
    const block = summary.slice(summary.indexOf('`````text'), summary.lastIndexOf('`````'));
    expect(block).toContain('```` and ``` inside');
  });

  test('anything but a verify document is refused by name', () => {
    expect(thrownBy(() => renderMergeSummary('{"command":"x"}', 'v.json', POINTER)).code).toBe(
      'X_VERIFY_MERGE_INPUT',
    );
  });
});
