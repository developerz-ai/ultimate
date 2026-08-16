// The pin ratchet, and only that: a step that stops passing and a pinned step that starts passing
// are both findings, and a step table that does not match the declared set is a third. The build
// graph, the suite floor, the `--unpin` edit and the subprocess seam each have their own file.

import { describe, expect, test } from 'bun:test';
import { PINS_FILE } from './lib/gated-apps';
import { parseUnpin } from './lib/unpin';
import { declaredStepIssues, gateFindings, pinnedRedSteps, tally } from './reference-app-gate';
import { app, appWith, namesOf, step } from './reference-app-gate.fixtures';

describe('gateFindings', () => {
  test('passes when the red steps are exactly the pinned ones', () => {
    const steps = [step('typecheck', false), step('drift', false), step('lint', true)];
    expect(gateFindings({ app, steps, referenced: false, declaredSteps: namesOf(steps) })).toEqual(
      [],
    );
  });

  test('a step that was passing and now fails is a regression', () => {
    const steps = [step('typecheck', false), step('drift', false), step('lint', false)];
    const findings = gateFindings({
      app,
      steps,
      referenced: false,
      declaredSteps: namesOf(steps),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(findings[0]?.cause).toContain('lint');
    expect(findings[0]?.fix).toContain('examples/dummy');
  });

  test('a pinned step that starts passing is a stale pin, so the pin can only shrink', () => {
    const steps = [step('typecheck', false), step('drift', true), step('lint', true)];
    const findings = gateFindings({
      app,
      steps,
      referenced: false,
      declaredSteps: namesOf(steps),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
    // A command to run, not a paragraph to perform — and the file is still named, in `at`.
    expect(findings[0]?.fix).toBe(
      'bun run scripts/reference-app-gate.ts --unpin examples/dummy:drift',
    );
    expect(findings[0]?.at).toBe(PINS_FILE);
  });

  test('the stale-pin fix carries every stale step, in one runnable line', () => {
    const steps = [step('typecheck', true), step('drift', true)];
    const findings = gateFindings({
      app,
      steps,
      referenced: true,
      declaredSteps: namesOf(steps),
    });
    const stale = findings.find((finding) => finding.code === 'X_REFERENCE_APP_PIN_STALE');
    expect(stale?.fix).toBe(
      'bun run scripts/reference-app-gate.ts --unpin examples/dummy:typecheck,drift',
    );
    expect(parseUnpin(stale?.fix.split('--unpin ')[1] ?? '')).toEqual({
      app: 'examples/dummy',
      steps: ['typecheck', 'drift'],
    });
  });

  test('every finding names the app, because there is more than one', () => {
    // Same red step, two apps: without the directory a reader cannot tell which gate to reproduce.
    const steps = [step('lint', false)];
    const declaredSteps = namesOf(steps);
    const demo = appWith({}, 'dummy/social-media-clone');
    const one = gateFindings({ app: appWith({}), steps, referenced: true, declaredSteps });
    const two = gateFindings({ app: demo, steps, referenced: true, declaredSteps });
    expect(one[0]?.cause).toContain('examples/dummy');
    expect(one[0]?.at).toBe('examples/dummy');
    expect(two[0]?.cause).toContain('dummy/social-media-clone');
    expect(two[0]?.at).toBe('dummy/social-media-clone');
    // ...and the reproduce line climbs out of whatever depth the app sits at.
    expect(two[0]?.fix).toContain('../../packages/cli/src/bin.ts');
    expect(one[0]?.fix).toContain('../../packages/cli/src/bin.ts');
  });

  test("one app's pins never excuse another's red step", () => {
    const steps = [step('drift', false)];
    const declaredSteps = namesOf(steps);
    expect(gateFindings({ app, steps, referenced: true, declaredSteps })).toHaveLength(1); // typecheck pin is stale
    const unpinned = gateFindings({
      app: appWith({}, 'dummy/social-media-clone'),
      steps,
      referenced: true,
      declaredSteps,
    });
    expect(unpinned.map((f) => f.code)).toEqual(['X_REFERENCE_APP_REGRESSED']);
  });

  test('a skipped step counts as not-red, not as a regression', () => {
    const steps = [step('typecheck', false), step('drift', false), step('roadmap', true, true)];
    expect(gateFindings({ app, steps, referenced: false, declaredSteps: namesOf(steps) })).toEqual(
      [],
    );
  });

  /**
   * `redSteps` filters skipped out, so a pinned step whose suite was deleted came back "not red"
   * and was reported as a stale pin — a finding whose fix is an `--unpin` line. Perform it and the
   * step is neither red nor pinned: green, forever, over a suite that no longer exists. Held
   * pinned instead; `floorFindings` is what turns the deletion itself into the finding.
   */
  test('a pinned step that turns SKIPPED is still pinned, never a stale pin', () => {
    const steps = [step('typecheck', false), step('drift', true, true)];
    expect(gateFindings({ app, steps, referenced: false, declaredSteps: namesOf(steps) })).toEqual(
      [],
    );
  });

  test('no step table at all is the worst outcome, never a silent pass', () => {
    const findings = gateFindings({
      app,
      steps: undefined,
      referenced: true,
      declaredSteps: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(gateFindings({ app, steps: [], referenced: true, declaredSteps: [] })).toHaveLength(1);
  });

  test('an empty pin means the app must be 100% green', () => {
    const steps = [step('typecheck', true), step('lint', false)];
    const codes = gateFindings({
      app: appWith({}),
      steps,
      referenced: true,
      declaredSteps: namesOf(steps),
    }).map((f) => f.code);
    expect(codes).toEqual(['X_REFERENCE_APP_REGRESSED']);
  });

  test('a declared step missing from the table is a regression, even with an empty pin and nothing red', () => {
    const steps = [step('typecheck', true), step('lint', true)];
    // 'roadmap' is declared but never printed — a crash mid-run, or a step the CLI forgot to
    // serialize, must not read as "nothing to report" just because everything present is green.
    const findings = gateFindings({
      app: appWith({}),
      steps,
      referenced: true,
      declaredSteps: [...namesOf(steps), 'roadmap'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(findings[0]?.cause).toContain('roadmap');
    expect(findings[0]?.cause).toContain('missing from the step table');
  });

  test('an unknown or duplicated step name is reported too, not silently trusted', () => {
    const steps = [step('typecheck', true), step('typecheck', true), step('mystery', true)];
    const findings = gateFindings({
      app: appWith({}),
      steps,
      referenced: true,
      declaredSteps: ['typecheck'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('mystery');
    expect(findings[0]?.cause).toContain('not a declared step');
    expect(findings[0]?.cause).toContain('typecheck');
    expect(findings[0]?.cause).toContain('more than once');
  });
});

describe('declaredStepIssues', () => {
  test('nothing to say when the table is exactly the declared set, in any order', () => {
    const steps = [step('drift', false), step('typecheck', true)];
    expect(declaredStepIssues(steps, ['typecheck', 'drift'])).toEqual([]);
  });
});

describe('tally', () => {
  test('a red step the table does not pin is red, and is not counted as pinned', () => {
    // `pin` holds typecheck and drift; `lint` is the regression the failing run has to explain.
    expect(tally(app, ['typecheck', 'drift', 'lint'], 17)).toBe(
      'examples/dummy 14/17, 3 red (2 pinned)',
    );
    expect(pinnedRedSteps(app, ['typecheck', 'drift', 'lint'])).toEqual(['typecheck', 'drift']);
  });

  test('every red step pinned reads as the ratchet holding', () => {
    expect(tally(app, ['typecheck'], 17)).toBe('examples/dummy 16/17, 1 red (1 pinned)');
    expect(tally(app, [], 17)).toBe('examples/dummy 17/17, 0 red (0 pinned)');
  });
});
