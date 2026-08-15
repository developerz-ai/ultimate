// The ratchet has to fail in both directions, or it is not a ratchet: a step that stops passing
// and a pinned step that starts passing are both findings. These pin that, the build-graph rule
// that fires the moment an app compiles, and — since there are two gated apps — that every finding
// says which app it is about.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult } from '@ultimat3/cli';
import type { GatedApp } from './lib/gated-apps';
import { PINS_FILE } from './lib/gated-apps';
import { repoRoot } from './lib/run';
import type { GateStep } from './reference-app-gate';
import {
  declaredStepIssues,
  gateFindings,
  parseSteps,
  ROOT_TSCONFIG,
  redSteps,
  referencesApp,
  reproduce,
  runAppGate,
  stepLines,
} from './reference-app-gate';

const step = (name: string, ok: boolean, skipped = false): GateStep => ({
  name,
  ok,
  skipped,
  findings: [],
});

const pin = { typecheck: 'owned elsewhere', drift: 'owned elsewhere' } as const;

const appWith = (expectedRed: Readonly<Record<string, string>>, dir = 'examples/dummy'): GatedApp =>
  ({ dir, reference: `./${dir}`, expectedRed }) satisfies GatedApp;

const app = appWith(pin);

// Each test's `steps` array IS its declared world — deriving `declaredSteps` from it rather than
// hand-listing a second copy means it can never drift from what the test actually constructs.
const namesOf = (steps: readonly GateStep[]): readonly string[] => steps.map((s) => s.name);

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
    expect(findings[0]?.fix).toContain(PINS_FILE);
    expect(findings[0]?.fix).toContain('drift');
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

describe('parseSteps', () => {
  const payload = JSON.stringify({
    ok: false,
    steps: [
      { name: 'lint', ok: true, durationMs: 1, skipped: false, findings: [] },
      {
        name: 'drift',
        ok: false,
        durationMs: 2,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'x db gen "m"', docs: 'd' }],
      },
    ],
  });

  test('reads the step table and keeps each finding’s three lines', () => {
    const steps = parseSteps(`${payload}\n`);
    expect(steps?.map((s) => s.name)).toEqual(['lint', 'drift']);
    expect(steps?.[1]?.findings[0]).toEqual({
      code: 'X_DB_DRIFT',
      cause: 'c',
      fix: 'x db gen "m"',
    });
    expect(redSteps(steps ?? [])).toEqual(['drift']);
  });

  test('a stray line before the payload does not make the gate unreadable', () => {
    expect(parseSteps(`warming up\n${payload}\n`)?.length).toBe(2);
  });

  test('unusable output is undefined rather than an empty pass', () => {
    expect(parseSteps('')).toBeUndefined();
    expect(parseSteps('{ not json')).toBeUndefined();
    expect(parseSteps('{"ok":true}')).toBeUndefined();
    expect(parseSteps('{"steps":[{"name":"lint"}]}')).toBeUndefined();
    // Valid JSON that is not an object at all — no line here even starts with `{`, so this never
    // reaches the `payload.steps` read, but the contract is "no usable table", not a thrown error.
    expect(parseSteps('null')).toBeUndefined();
    expect(parseSteps('[]')).toBeUndefined();
    expect(parseSteps('true')).toBeUndefined();
  });
});

describe('wiring', () => {
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

  test('the reproduce line climbs exactly as far as the app is deep', () => {
    expect(reproduce(appWith({}))).toBe(
      'cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify',
    );
    expect(reproduce(appWith({}, 'a/b/c'))).toContain('../../../packages/cli/src/bin.ts');
  });

  test('the step table renders pinned steps and their findings', () => {
    const steps: GateStep[] = [
      {
        name: 'drift',
        ok: false,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'f' }],
      },
      step('roadmap', true, true),
    ];
    const lines = stepLines(steps, pin).join('\n');
    expect(lines).toContain('✗ drift');
    expect(lines).toContain('pinned');
    expect(lines).toContain('X_DB_DRIFT');
    expect(lines).toContain('- roadmap');
  });

  test('runs each app’s gate in that app, through the repo’s own CLI entry point', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const fake = async (command: readonly string[], options: { cwd: string }) => {
      calls.push({ command, cwd: options.cwd });
      return {
        command,
        code: 1,
        ok: false,
        stdout: '{"steps":[{"name":"lint","ok":true,"skipped":false,"findings":[]}]}',
        stderr: '',
        durationMs: 0,
      } satisfies ExecResult;
    };
    const steps = await runAppGate('/repo', fake, 'dummy/social-media-clone');
    expect(steps?.map((s) => s.name)).toEqual(['lint']);
    expect(calls[0]?.cwd).toBe('/repo/dummy/social-media-clone');
    expect(calls[0]?.command).toEqual([
      'bun',
      'run',
      '/repo/packages/cli/src/bin.ts',
      'verify',
      '--json',
    ]);
  });
});
