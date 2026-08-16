// One rule: an app that typechecks has no excuse for sitting outside `tsc -b`. Both halves are
// here — the decision (`X_REFERENCE_APP_UNREFERENCED`, which fires the moment the `typecheck` pin
// comes off) and the disk read that answers whether the root solution names the app at all.

import { describe, expect, test } from 'bun:test';
// `referencesApp` reads a real root config off disk, so the test needs a real throwaway directory
// to put one in. Bun ships no temp-dir, no recursive remove and no path-join primitive.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import { gateFindings, ROOT_TSCONFIG, referencesApp } from './reference-app-gate';
import { app, appWith, namesOf, step } from './reference-app-gate.fixtures';

describe('the build-graph rule', () => {
  test('an app that typechecks must be in the root build graph', () => {
    const steps = [step('typecheck', true), step('drift', false)];
    const codes = gateFindings({
      app,
      steps,
      referenced: false,
      declaredSteps: namesOf(steps),
    }).map((f) => f.code);
    expect(codes).toContain('X_REFERENCE_APP_UNREFERENCED');
    // Both are true at once and each needs its own edit: lower the pin AND add the reference.
    expect(codes).toContain('X_REFERENCE_APP_PIN_STALE');
  });

  test('the unreferenced fix names the app’s own references entry', () => {
    const steps = [step('typecheck', true)];
    const findings = gateFindings({
      app: appWith({}, 'dummy/social-media-clone'),
      steps,
      referenced: false,
      declaredSteps: namesOf(steps),
    });
    expect(findings[0]?.fix).toContain('"./dummy/social-media-clone"');
  });

  test('once referenced, a green typecheck raises nothing', () => {
    const steps = [step('typecheck', true), step('drift', false)];
    const codes = gateFindings({
      app: appWith({ drift: 'owned elsewhere' }),
      steps,
      referenced: true,
      declaredSteps: namesOf(steps),
    }).map((f) => f.code);
    expect(codes).toEqual([]);
  });
});

describe('referencesApp', () => {
  test('the root tsconfig is read for a real reference entry, not a substring', async () => {
    expect(await referencesApp(repoRoot(), './examples/dummy')).toBe(false);
    expect(await referencesApp(repoRoot(), './packages/core')).toBe(true);
  });

  test('a references entry with no path (null, or anything not an object) is a non-match, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reference-app-gate-'));
    try {
      await Bun.write(
        join(dir, ROOT_TSCONFIG),
        JSON.stringify({ references: [null, 'not-an-object', 42, { path: './other' }] }),
      );
      expect(await referencesApp(dir, './examples/dummy')).toBe(false);

      await Bun.write(
        join(dir, ROOT_TSCONFIG),
        JSON.stringify({ references: [null, { path: './examples/dummy' }] }),
      );
      expect(await referencesApp(dir, './examples/dummy')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
