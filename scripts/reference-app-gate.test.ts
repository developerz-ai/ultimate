// The ratchet has to fail in both directions, or it is not a ratchet: a step that stops passing
// and a pinned step that starts passing are both findings. These pin that, the build-graph rule
// that fires the moment an app compiles, and — since there are two gated apps — that every finding
// says which app it is about.

import { describe, expect, test } from 'bun:test';
// All four are `node:`-only by necessity: `referencesApp` reads a real root config off disk, so
// the test needs a real throwaway directory to put one in. Bun ships no temp-dir, no recursive
// remove and no path-join primitive — `Bun.write` creates files but never the scratch root, and
// `Bun.file().unlink()` cannot remove a directory tree.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult } from '@ultimat3/cli';
import type { GatedApp } from './lib/gated-apps';
import { GATED_APPS, PINS_FILE } from './lib/gated-apps';
import { repoRoot } from './lib/run';
import { parseUnpin, pinnedSteps } from './lib/unpin';
import type { GateStep } from './reference-app-gate';
import {
  declaredStepIssues,
  gateFindings,
  parseSteps,
  pinnedRedSteps,
  ROOT_TSCONFIG,
  redSteps,
  referencesApp,
  reproduce,
  runAppGate,
  stepLines,
  tally,
  unpin,
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

describe('unpin', () => {
  /** A throwaway repo root holding a copy of the real pins file, so no test edits the real one. */
  const withPinsCopy = async (
    body: (root: string, path: string) => Promise<void>,
    source?: string,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'reference-app-unpin-'));
    const path = join(root, PINS_FILE);
    try {
      await Bun.write(path, source ?? (await Bun.file(join(repoRoot(), PINS_FILE)).text()));
      await body(root, path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const target = GATED_APPS.find((candidate) => Object.keys(candidate.expectedRed).length > 1);

  test('removes the named pin and leaves the app’s other pins alone', async () => {
    await withPinsCopy(async (root, path) => {
      const [first, ...rest] = Object.keys(target?.expectedRed ?? {});
      const result = await unpin(root, `${target?.dir}:${first}`);
      expect(result.ok).toBe(true);
      expect(result.summary).toContain(`${target?.dir}: unpinned ${first}`);
      expect(pinnedSteps(await Bun.file(path).text(), target?.dir ?? '')).toEqual(rest);
    });
  });

  test('a step that is not pinned changes nothing, and says what is', async () => {
    await withPinsCopy(async (root, path) => {
      const before = await Bun.file(path).text();
      const result = await unpin(root, `${target?.dir}:lint`);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.cause).toContain('lint is not pinned');
      expect(await Bun.file(path).text()).toBe(before);
    });
  });

  test('an unknown app names the apps that do exist', async () => {
    await withPinsCopy(async (root) => {
      const result = await unpin(root, 'examples/nope:drift');
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.fix).toContain(GATED_APPS[0]?.dir ?? '');
    });
  });

  test('a malformed --unpin is a bad flag, not a guess', async () => {
    await withPinsCopy(async (root) => {
      expect((await unpin(root, 'examples/dummy')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect((await unpin(root, '')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    });
  });

  test('a file that disagrees with the imported table is refused, entry present or not', async () => {
    // The dangerous near-miss: the entry IS there, so the transform would happily delete it —
    // but the file holds a pin the gate's own import does not, so this process is editing a table
    // it has already misread. Whatever else is wrong, guessing which line to delete is worse.
    const keys = Object.keys(target?.expectedRed ?? {});
    const drifted = [
      '  {',
      `    dir: '${target?.dir}',`,
      '    expectedRed: {',
      ...keys.map((key) => `      ${key}: 'owned elsewhere',`),
      "      lint: 'added on disk after this process imported the table',",
      '    } satisfies Partial<Record<VerifyStepName, string>>,',
      '  },',
    ].join('\n');
    await withPinsCopy(async (root, path) => {
      const result = await unpin(root, `${target?.dir}:${keys[0]}`);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
      expect(await Bun.file(path).text()).toBe(drifted);
    }, drifted);
  });

  test('a pins file this cannot read is a hand edit, and the file is left untouched', async () => {
    // The keys are real; the shape is not one the text parser recognises, so the edit must not
    // run — deleting the wrong line here would widen the ratchet silently.
    const mangled = `export const GATED_APPS = [{ dir: '${target?.dir}', expectedRed: {} }];\n`;
    await withPinsCopy(async (root, path) => {
      const result = await unpin(
        root,
        `${target?.dir}:${Object.keys(target?.expectedRed ?? {})[0]}`,
      );
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
      expect(result.findings?.[0]?.fix).toContain(PINS_FILE);
      expect(await Bun.file(path).text()).toBe(mangled);
    }, mangled);
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
