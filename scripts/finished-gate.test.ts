// `finished-gate.ts`: the gate-whole row over fixture app floors — whole, pinned red, a step not
// asserted, not strict, unreadable, and no app at all.

import { describe, expect, test } from 'bun:test';
import { gateRow } from './finished-gate';

const STEPS = ['typecheck', 'unit', 'job', 'roadmap'];
const whole = { steps: ['typecheck', 'unit', 'job'], skip: { roadmap: 'repo only' }, strict: true };
const app = (overrides: Record<string, unknown> = {}) => ({
  dir: 'apps/one',
  expectedRed: {},
  floor: whole,
  ...overrides,
});

describe('finished · gate-whole', () => {
  test('every app step asserted, strict, nothing pinned red: green', () => {
    expect(gateRow([app()], STEPS).verdict).toBe('green');
  });

  test('a step pinned red in GATED_APPS is red', () => {
    const row = gateRow([app({ expectedRed: { unit: 'owed' } })], STEPS);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.cause).toContain('pins its unit step red');
  });

  test('a skipped app step is red, roadmap alone being the framework’s', () => {
    const floor = { ...whole, steps: ['typecheck', 'unit'], skip: { job: 'none', roadmap: 'r' } };
    const row = gateRow([app({ floor })], STEPS);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.cause).toContain('does not assert job (skipped: job)');
    expect(row.findings[0]?.fix).toStartWith('edit apps/one/x.verify.json:1 — ');
  });

  test('a floor that is not strict, or not readable, is red', () => {
    expect(gateRow([app({ floor: { ...whole, strict: false } })], STEPS).verdict).toBe('red');
    expect(gateRow([app({ floor: undefined })], STEPS).verdict).toBe('red');
  });

  test('no tracked app at all is red, never a vacuous green', () => {
    expect(gateRow([], STEPS).verdict).toBe('red');
  });
});
