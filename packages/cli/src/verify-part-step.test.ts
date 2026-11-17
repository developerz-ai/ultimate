// A part's step is read against the shape `mergeStep` relies on: what a live step's services were
// rides through, and a value the gate never writes is refused rather than believed.

import { describe, expect, test } from 'bun:test';
import { renderJson } from './output';
import { readPartStep } from './verify-part-step';

const step = { name: 'live', ok: true, durationMs: 4, findings: [] };

describe('unit · readPartStep · services', () => {
  test('reached and unavailable ride through; absent stays absent', () => {
    expect(readPartStep({ ...step, services: 'reached' })).toMatchObject({ services: 'reached' });
    expect(readPartStep({ ...step, services: 'unavailable' })).toMatchObject({
      services: 'unavailable',
    });
    expect(readPartStep(step)).not.toHaveProperty('services');
  });

  test('any other value is refused, naming the step', () => {
    expect(readPartStep({ ...step, services: 'up' })).toBe(
      'holds step "live" whose services is neither reached nor unavailable',
    );
  });
});

// The contract a part is: what `x verify --json` writes is what `x verify merge` reads. `renderJson`
// copies a step field by field, and one it does not name never reaches the merge.
test('unit · a live step’s services survive the --json a part is written as', () => {
  const json = renderJson({
    ok: true,
    command: 'verify',
    summary: 'ok',
    steps: [{ ...step, tests: { ran: 2, skipped: 1 }, services: 'reached' }],
  });
  const parsed = JSON.parse(json) as { steps: unknown[] };
  expect(readPartStep(parsed.steps[0])).toMatchObject({ services: 'reached' });
});
