// `x verify --changed`, the pure half: each changed file (app-root-relative) to the rule it falls
// under, each rule to the gate steps whose inputs it can move. Fail-open by construction: a path
// no rule speaks for — a root config, an unknown directory, a deleted module, a file outside the
// app — selects the whole step list, so a narrowing can only ever skip a step it can prove idle.

import { isTest } from './source-files';
import type { VerifyStepName } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';
import { ownerOf } from './verify-tests';

export type ChangeRule =
  | 'outside'
  | 'root-config'
  | 'unknown'
  | 'deleted'
  | 'doc'
  | 'test'
  | 'drift-input'
  | 'generated'
  | 'source';

/** What the disk says, read once by `verify-changed-facts.ts`, so this file needs no disk. */
export interface ChangedFacts {
  /**
   * Every app file an entity declaration or `packages/db` reaches by import — what `drift` hashes
   * and compares — or `'everything'` when one of them computes an import nobody can follow.
   */
  readonly driftReach: ReadonlySet<string> | 'everything';
  /** Every TypeScript file the app holds now: a changed one missing here was deleted or moved. */
  readonly known: ReadonlySet<string>;
}

/** Directories whose files are app source: imported, so read by the steps that load the app. */
const SOURCE_DIRS = new Set(['apps', 'packages', 'guards', 'scripts', 'types', 'bin']);

/** Prose: no step compiles it; the steps that read it are `DOC_STEPS`. */
const isDoc = (path: string): boolean =>
  path.endsWith('.md') || path.startsWith('docs/') || path.startsWith('wiki/');

/**
 * What the `drift` step reads beyond the entity closure: the migrations and the db package, a
 * generated client (`apps/<app>/clients/`) and the document it is stamped from (`openapi.json`).
 */
const isDriftFile = (path: string): boolean =>
  path.startsWith('packages/db/') ||
  /^apps\/[^/]+\/clients\//.test(path) ||
  path === 'openapi.json';

const isTypeScript = (path: string): boolean => /\.[cm]?tsx?$/.test(path);

/** The one rule a changed file falls under, most specific first. */
export function classifyChange(path: string, facts: ChangedFacts): ChangeRule {
  if (path.startsWith('../')) return 'outside';
  if (isDoc(path)) return 'doc';
  if (isTest(path) || /(^|\/)e2e\//.test(path)) return 'test';
  if (isDriftFile(path)) return 'drift-input';
  if (path === 'x.manifest.json') return 'generated';
  const top = path.split('/')[0] ?? '';
  // Root-level files are read, not imported: `app.config.ts`, `bun.lock`, `x.verify.json` (the
  // floor every step answers to), `tsconfig.json`, `biome.json`.
  // `app.config.ts` anywhere: below the root it is a second app root (`X_APP_ROOT_NESTED`).
  if (!path.includes('/') || path.endsWith('/app.config.ts')) return 'root-config';
  if (!SOURCE_DIRS.has(top)) return 'unknown';
  // A module gone from disk took its importers' facts with it, entity declarations included.
  if (isTypeScript(path) && !facts.known.has(path)) return 'deleted';
  if (facts.driftReach === 'everything' || facts.driftReach.has(path)) return 'drift-input';
  return 'source';
}

const DOC_STEPS: readonly VerifyStepName[] = [
  'package-shape',
  'errors',
  'unit',
  'manifest',
  'roadmap',
];
const TEST_STEPS: readonly VerifyStepName[] = [
  'typecheck',
  'lint',
  'filesize',
  'package-shape',
  'errors',
];
const GENERATED_STEPS: readonly VerifyStepName[] = ['lint', 'contract-diff', 'manifest'];
const NOT_DRIFT = VERIFY_STEP_NAMES.filter((name) => name !== 'drift');

/** The steps one file selects under its rule. */
export function stepsOfChange(path: string, rule: ChangeRule): readonly VerifyStepName[] {
  switch (rule) {
    case 'doc':
      return DOC_STEPS;
    case 'test':
      return [...TEST_STEPS, ownerOf(path)];
    case 'generated':
      return GENERATED_STEPS;
    case 'source':
      return NOT_DRIFT;
    default:
      return VERIFY_STEP_NAMES;
  }
}

export interface ChangedStep {
  readonly name: VerifyStepName;
  /** The changed files that selected it, in diff order. */
  readonly files: readonly string[];
}

export interface ChangedStepPlan {
  readonly files: readonly { readonly path: string; readonly rule: ChangeRule }[];
  /** In gate order — what `--only` would have run. Empty when nothing changed. */
  readonly steps: readonly ChangedStep[];
}

export function planChangedSteps(paths: readonly string[], facts: ChangedFacts): ChangedStepPlan {
  const files = paths.map((path) => ({ path, rule: classifyChange(path, facts) }));
  const selected = new Map<VerifyStepName, string[]>();
  for (const file of files) {
    for (const step of stepsOfChange(file.path, file.rule)) {
      const known = selected.get(step);
      if (known === undefined) selected.set(step, [file.path]);
      else if (!known.includes(file.path)) known.push(file.path);
    }
  }
  const steps = VERIFY_STEP_NAMES.flatMap((name) => {
    const named = selected.get(name);
    return named === undefined ? [] : [{ name, files: named }];
  });
  return { files, steps };
}

/** The suites `--changed` narrows to selected test files (`ctx.tests`); `eval` keeps its own rules. */
const NARROWED_SUITES: ReadonlySet<VerifyStepName> = new Set([
  'unit',
  'contract',
  'live',
  'job',
  'e2e',
]);

/** The rules whose files the import closure speaks for; any other rule's suites run whole. */
const CLOSURE_RULES: ReadonlySet<ChangeRule> = new Set(['source', 'test', 'drift-input']);

export interface NarrowedPlan {
  readonly plan: ChangedStepPlan;
  /** Suites a file outside the closure's reach selected (a doc): they run every test. */
  readonly whole: readonly VerifyStepName[];
}

/**
 * The plan without the suites no kept test belongs to — a suite with nothing to run would read as
 * a vanished one (`X_VERIFY_SUITE_VANISHED`). `kept` is what `x test --affected` would run: the
 * closure's tests AND every test the module graph never read. A suite a doc (or any rule the
 * closure cannot speak for) selected is kept and run whole: a test reads a doc by no import.
 * `kept` undefined: a changed file forced every test, and every suite stays as planned.
 */
export function narrowSuites(
  plan: ChangedStepPlan,
  kept: readonly string[] | undefined,
): NarrowedPlan {
  if (kept === undefined) return { plan, whole: [] };
  const owned = new Set<VerifyStepName>(kept.map((path) => ownerOf(path)));
  const rules = new Map(plan.files.map((file) => [file.path, file.rule]));
  const whole: VerifyStepName[] = [];
  const steps = plan.steps.filter((step) => {
    if (!NARROWED_SUITES.has(step.name)) return true;
    if (step.files.some((path) => !CLOSURE_RULES.has(rules.get(path) ?? 'unknown'))) {
      whole.push(step.name);
      return true;
    }
    return owned.has(step.name);
  });
  return { plan: { ...plan, steps }, whole };
}
