import { describe, expect, test } from 'bun:test';
import type { ChangedFacts, ChangeRule } from './verify-changed';
import { classifyChange, narrowSuites, planChangedSteps } from './verify-changed';
import { VERIFY_STEP_NAMES } from './verify-step';

const facts = (overrides: Partial<ChangedFacts> = {}): ChangedFacts => ({
  driftReach: new Set(['apps/web/app/post/entity.ts', 'packages/domain/src/money.ts']),
  known: new Set([
    'apps/web/app/post/entity.ts',
    'apps/web/app/post/service.ts',
    'apps/web/site/page.tsx',
    'packages/domain/src/money.ts',
    'packages/ui/src/card.tsx',
    'guards/raw-fetch.ts',
    'apps/api/app.config.ts',
  ]),
  ...overrides,
});

const stepsOf = (paths: readonly string[], given: ChangedFacts = facts()): readonly string[] =>
  planChangedSteps(paths, given).steps.map((step) => step.name);

/** One row per rule: a path and the rule `classifyChange` must give it. */
const RULE_CASES: [string, ChangeRule][] = [
  ['../packages/core/src/x.ts', 'outside'],
  ['README.md', 'doc'],
  ['docs/ops/deploy.md', 'doc'],
  ['wiki/Home.md', 'doc'],
  ['apps/web/app/post/service.test.ts', 'test'],
  ['apps/web/e2e/helpers.ts', 'test'],
  ['apps/web/app/post/entity.ts', 'drift-input'],
  ['packages/domain/src/money.ts', 'drift-input'],
  ['packages/db/migrations/20261101_initial.sql', 'drift-input'],
  ['apps/web/clients/stripe/client.ts', 'drift-input'],
  ['openapi.json', 'drift-input'],
  ['x.manifest.json', 'generated'],
  ['app.config.ts', 'root-config'],
  // A second app root (X_APP_ROOT_NESTED, the drift step's) is never "just source".
  ['apps/api/app.config.ts', 'root-config'],
  ['bun.lock', 'root-config'],
  ['x.verify.json', 'root-config'],
  ['apps/web/site/page.tsx', 'source'],
  ['packages/ui/src/card.module.scss', 'source'],
  ['guards/raw-fetch.ts', 'source'],
  ['apps/web/app/post/gone.ts', 'deleted'],
  ['docker/Dockerfile', 'unknown'],
];

describe('unit · verify --changed maps each changed file to a rule', () => {
  test.each(RULE_CASES)('%s → %s', (path, rule) => {
    expect(classifyChange(path, facts())).toBe(rule);
  });

  test('an opaque entity closure makes every source file a drift input', () => {
    expect(classifyChange('packages/ui/src/card.tsx', facts({ driftReach: 'everything' }))).toBe(
      'drift-input',
    );
  });
});

describe('unit · verify --changed selects the steps whose inputs moved', () => {
  test('nothing changed selects no step', () => {
    expect(stepsOf([])).toEqual([]);
  });

  test('a source change outside every entity closure runs everything but drift (B3)', () => {
    const steps = stepsOf(['apps/web/site/page.tsx']);
    expect(steps).not.toContain('drift');
    expect(steps).toEqual(VERIFY_STEP_NAMES.filter((name) => name !== 'drift'));
  });

  test('an entity, a migration or a module an entity imports runs drift', () => {
    for (const path of [
      'apps/web/app/post/entity.ts',
      'packages/db/migrations/1.sql',
      'packages/domain/src/money.ts',
    ]) {
      expect(stepsOf([path])).toContain('drift');
    }
  });

  test('a docs-only diff runs the doc steps alone', () => {
    expect(stepsOf(['README.md', 'docs/a.md'])).toEqual([
      'package-shape',
      'errors',
      'unit',
      'manifest',
      'roadmap',
    ]);
  });

  test('a test-only diff runs the cheap checks and the suite that owns each file', () => {
    expect(
      stepsOf(['apps/web/app/post/service.test.ts', 'apps/web/app/post/x.contract.test.ts']),
    ).toEqual(['typecheck', 'lint', 'filesize', 'package-shape', 'errors', 'unit', 'contract']);
  });

  test('root config, an unknown path, a deleted module and a file outside the app run the gate', () => {
    for (const path of ['bun.lock', 'docker/Dockerfile', 'apps/web/gone.ts', '../x.ts']) {
      expect(stepsOf([path])).toEqual([...VERIFY_STEP_NAMES]);
    }
  });

  test('steps come back in gate order and each names the files that selected it', () => {
    const plan = planChangedSteps(['x.manifest.json', 'README.md'], facts());
    expect(plan.steps.map((step) => step.name)).toEqual([
      'lint',
      'package-shape',
      'errors',
      'unit',
      'contract-diff',
      'manifest',
      'roadmap',
    ]);
    expect(plan.steps.find((step) => step.name === 'manifest')?.files).toEqual([
      'x.manifest.json',
      'README.md',
    ]);
    expect(plan.files).toEqual([
      { path: 'x.manifest.json', rule: 'generated' },
      { path: 'README.md', rule: 'doc' },
    ]);
  });
});

describe('unit · the suites narrow to the tests the import closure reaches', () => {
  const plan = planChangedSteps(['apps/web/site/page.tsx'], facts());

  test('a suite no selected test belongs to is dropped; eval and exercise are never', () => {
    const narrowed = narrowSuites(plan, ['apps/web/site/page.test.ts', 'apps/web/x.e2e.test.ts']);
    const names = narrowed.plan.steps.map((step) => step.name);
    expect(names).toContain('unit');
    expect(names).toContain('e2e');
    for (const gone of ['contract', 'live', 'job']) expect(names).not.toContain(gone);
    expect(names).toContain('eval');
    expect(names).toContain('exercise');
  });

  test('no selection (a file forced every test) keeps every suite', () => {
    expect(narrowSuites(plan, undefined)).toEqual({ plan, whole: [] });
  });

  // A doc is read by tests (wiki fences, cited paths) through no import: the closure cannot see
  // it, so a suite a doc selected runs whole rather than vanishing from the run.
  test('a doc-only diff keeps unit, and runs it whole', () => {
    const narrowed = narrowSuites(planChangedSteps(['README.md'], facts()), []);
    expect(narrowed.plan.steps.map((step) => step.name)).toContain('unit');
    expect(narrowed.whole).toEqual(['unit']);
  });

  test('a suite a source file alone selected stays narrowed', () => {
    expect(narrowSuites(plan, ['apps/web/site/page.test.ts']).whole).toEqual([]);
  });
});
