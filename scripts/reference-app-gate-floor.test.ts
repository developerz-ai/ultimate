// The suite floor, the half of the ratchet that catches a DELETED suite: without a committed
// `x.verify.json` a deleted suite turns its step from red into skipped, which is neither a
// regression nor a stale pin, so both app gates stayed green over a suite that no longer existed.

import { describe, expect, test } from 'bun:test';
// `join` builds the host-separator path to each app root; Bun ships no equivalent.
import { join } from 'node:path';
import { readVerifyFloor } from '@ultimat3/cli';
import { GATED_APPS } from './lib/gated-apps';
import { repoRoot } from './lib/run';
import { floorFindings, reproduce } from './reference-app-gate';
import { app, step } from './reference-app-gate.fixtures';

describe('floorFindings', () => {
  const ran = [step('unit', true), step('contract', false)];

  test('an app with no committed floor is a finding carrying the file to write', () => {
    const findings = floorFindings({ app, steps: ran, floor: undefined });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REFERENCE_APP_NO_FLOOR']);
    expect(findings[0]?.at).toBe('examples/dummy/x.verify.json');
    // Runnable as written: the fix is the exact file body, derived from what this run proved.
    expect(findings[0]?.fix).toBe(
      'write examples/dummy/x.verify.json as {"steps":["unit","contract"]}',
    );
    // An unreadable or empty floor enforces nothing, so it is the same finding as no file at all.
    expect(floorFindings({ app, steps: ran, floor: [] })).toEqual(findings);
  });

  test('a step this run proved applies that the floor does not name is the same finding', () => {
    const findings = floorFindings({ app, steps: ran, floor: ['unit'] });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REFERENCE_APP_NO_FLOOR']);
    expect(findings[0]?.cause).toContain('contract');
    expect(findings[0]?.fix).toBe(
      'add "contract" to the "steps" array in examples/dummy/x.verify.json',
    );
  });

  /**
   * The mirror, and the hole the floor exists for: delete the `contract` suite and its step turns
   * skipped, which `redSteps` filters out and `expectedRed` then reads as repaired.
   */
  test('a floor-named step that came back SKIPPED is a regression, not a skip', () => {
    const steps = [step('unit', true), step('contract', true, true)];
    const findings = floorFindings({ app, steps, floor: ['unit', 'contract'] });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REFERENCE_APP_REGRESSED']);
    expect(findings[0]?.cause).toContain('contract');
    expect(findings[0]?.fix).toBe(reproduce(app));
  });

  test('a floor that matches the run exactly raises nothing, and a step it drops is allowed', () => {
    expect(floorFindings({ app, steps: ran, floor: ['unit', 'contract'] })).toEqual([]);
    // `roadmap` skips in every app and is in neither floor: a step that never applied here is not
    // a vanished suite, and demanding it would pin both gates red over a framework-only step.
    const steps = [...ran, step('roadmap', true, true)];
    expect(floorFindings({ app, steps, floor: ['unit', 'contract'] })).toEqual([]);
  });

  test('no step table at all is gateFindings’ finding, never a second one from here', () => {
    expect(floorFindings({ app, steps: [], floor: undefined })).toEqual([]);
  });

  /**
   * The committed half. Both tracked apps carry a floor naming every step their own gate reports
   * as applying — derived by running each app's `x verify --json`, never guessed — and this is what
   * keeps a new file from being written and then forgotten.
   */
  test('both gated apps commit a floor that parses and names real steps', async () => {
    for (const gated of GATED_APPS) {
      const floor = await readVerifyFloor(join(repoRoot(), gated.dir));
      expect(floor?.problems).toEqual([]);
      expect(floor?.steps.length ?? 0).toBeGreaterThan(0);
      // Every step the app is allowed to fail is a step whose suite must still exist: a pin over a
      // deleted suite is the exact false green this pairing closes.
      for (const pinned of Object.keys(gated.expectedRed)) {
        expect(floor?.steps).toContain(pinned);
      }
    }
  });
});
