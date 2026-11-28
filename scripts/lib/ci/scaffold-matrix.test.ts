// Which scaffolds ci.yml's `scaffold-smoke` runs: every row on anything but a pull request, and on a
// pull request every row only when the diff reaches the code that writes a scaffold.

import { describe, expect, test } from 'bun:test';
import { NEW_SHAPES } from '../../../packages/cli/src/new-shapes';
import { SCAFFOLD_ROWS, SCAFFOLD_SAMPLE, scaffoldPlan } from './scaffold-matrix';

const apps = (files: readonly string[], event = 'pull_request'): readonly string[] =>
  scaffoldPlan(files, event).matrix.include.map((row) => row.app);

describe('unit · ci · the scaffold-smoke rows', () => {
  // A shape `x new` accepts is one a stranger can pick, so it has a row the day it lands.
  test('the default, --no-example, one row per x new --shape, and the monorepo', () => {
    expect(SCAFFOLD_ROWS.map((row) => row.flags)).toEqual([
      '',
      '--no-example',
      ...NEW_SHAPES.map((shape) => `--shape ${shape}`),
      '',
    ]);
    expect(SCAFFOLD_ROWS.map((row) => row.app)).toEqual([
      'demoapp',
      'bareapp',
      ...NEW_SHAPES.map((shape) => `${shape}app`),
      'multiapp',
    ]);
  });

  test('the sample is three real rows: the default, the bare app, and one --shape', () => {
    expect([...SCAFFOLD_SAMPLE]).toEqual(['demoapp', 'bareapp', 'saasapp']);
    const names = SCAFFOLD_ROWS.map((row) => row.app);
    for (const app of SCAFFOLD_SAMPLE) expect(names).toContain(app);
  });
});

describe('unit · ci · a pull request away from the scaffold code runs the sample', () => {
  test.each([
    ['packages/ui/src/button.tsx'],
    ['packages/realtime/src/live-fanout.ts'],
    ['packages/cli/src/verify-step.ts'],
    ['scripts/ci-workflow-shape.test.ts'],
    ['wiki/Home.md'],
  ])('%s alone: the three sampled rows', (path) => {
    expect(apps([path])).toEqual(['demoapp', 'bareapp', 'saasapp']);
    expect(scaffoldPlan([path], 'pull_request').full).toBe(false);
  });

  test('the sample keeps each row`s flags, in the matrix order', () => {
    expect(scaffoldPlan(['packages/ui/src/a.ts'], 'pull_request').matrix.include).toEqual([
      { app: 'demoapp', flags: '' },
      { app: 'bareapp', flags: '--no-example' },
      { app: 'saasapp', flags: '--shape saas' },
    ]);
  });
});

describe('unit · ci · every row runs when a doubt or the scaffold code is in the diff', () => {
  const every = SCAFFOLD_ROWS.map((row) => row.app);

  test.each([
    'packages/cli/src/templates/shapes/realtime/app.ts',
    'packages/cli/src/templates/action.ts',
    'packages/cli/src/cmd-new.ts',
    'packages/cli/src/cmd-new-target.ts',
    'packages/cli/src/cmd-generate.ts',
    'packages/cli/src/generate-feature.ts',
    'packages/cli/src/generated-imports.ts',
    'packages/cli/src/new-shapes.ts',
    'packages/cli/src/scaffold-fixture.ts',
    'packages/cli/src/write-generated.ts',
    'packages/cli/package.json',
    'packages/ui/package.json',
    'package.json',
    'bun.lock',
    'packages/create-ultimate/src/index.ts',
    'scripts/scaffold-smoke-steps.ts',
    'scripts/scaffold-smoke-overrides.ts',
    'scripts/generator-counts.ts',
    'scripts/template-codemods-rows.ts',
    'scripts/ci-changes.ts',
    'scripts/lib/ci/scaffold-matrix.ts',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
  ])('%s: every row', (path) => {
    expect(apps(['wiki/Home.md', path])).toEqual(every);
    expect(scaffoldPlan([path], 'pull_request').full).toBe(true);
  });

  // git quotes a path with unusual bytes, and a path that climbs out is not a repo path.
  test.each([
    '"packages/cli/src/templates/caf\\303\\251.ts"',
    'packages/ui/../cli/src/templates/x.ts',
  ])('%s is a doubt: every row', (path) => {
    expect(apps([path])).toEqual(every);
  });

  test('no list — the diff step failed — is every row', () => {
    expect(apps([])).toEqual(every);
    expect(scaffoldPlan([], 'pull_request').reason).toContain('no changed paths');
  });

  test.each(['push', 'workflow_dispatch', 'schedule', ''])(
    'a %s run is every row, whatever the diff',
    (event) => {
      expect(apps(['packages/ui/src/button.tsx'], event)).toEqual(every);
    },
  );
});
