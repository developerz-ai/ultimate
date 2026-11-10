// `x verify --changed`, resolved: the diff (`affected.ts`'s one reader of `--base`/`--dirty`, so
// `x affected` and this flag can never measure a change against two different bases), re-rooted
// onto the app, then planned. What `cmd-verify.ts` narrows the run with, and what `--json` reports.

// why: Bun ships no path API; git prints paths from the checkout root, the planner reads app-relative.
import { join, relative, resolve } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import type { AffectedSelection } from './affected';
import { changedFiles, gitRoot, readAffectedSelection, resolveSelection } from './affected';
import type { AppTestScope } from './affected-tests';
import { appTestScope, narrowToApp } from './affected-tests';
import { BadFlagError } from './errors';
import type { Runner } from './exec';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { discoverTests } from './test-select';
import type { ChangedFacts, ChangedStepPlan } from './verify-changed';
import { narrowSuites, planChangedSteps } from './verify-changed';
import { readChangedFacts } from './verify-changed-facts';
import type { ChangedTestSelection, VerifyStepName } from './verify-step';

/** Every test file a suite would discover, app-root-relative. */
const discoverAll = async (root: string): Promise<readonly string[]> =>
  (await discoverTests(root)).map((file) => file.path);

export interface ChangedScope {
  readonly selection: AffectedSelection;
  /** Suites already narrowed to `tests.kept`. */
  readonly plan: ChangedStepPlan;
  /**
   * What each suite runs — `undefined` when a changed file forced every test (or no app). `kept`
   * is `x test --affected`'s answer: the closure's tests and every test the graph never read.
   */
  readonly tests: ChangedTestRun | undefined;
  /** The changed files that forced every test, when one did. */
  readonly forcing: readonly string[];
}

/** `VerifyContext.tests`, plus the files it keeps, for `--json`. */
export interface ChangedTestRun extends ChangedTestSelection {
  readonly kept: readonly string[];
}

const toPosix = (path: string): string => path.split('\\').join('/');

/** Checkout-relative paths onto the app root: a file outside the app comes back `../…`. */
export const reRoot = (checkout: string, app: string, paths: readonly string[]): string[] =>
  paths.map((path) => toPosix(relative(resolve(app), join(resolve(checkout), path))));

export async function changedScope(options: {
  readonly runner: Runner;
  readonly root: string;
  readonly args: ParsedArgs;
  /** Injected by tests; the real read walks the app once. */
  readonly facts?: (root: string) => Promise<ChangedFacts>;
  /** Injected by tests; the real one is `x test --affected`'s selection. */
  readonly tests?: (
    root: string,
    checkout: string,
    changed: readonly string[],
  ) => Promise<AppTestScope | undefined>;
  /** Injected by tests; the real one is the suites' own discovery, every type. */
  readonly discover?: (root: string) => Promise<readonly string[]>;
}): Promise<ChangedScope> {
  const request = readAffectedSelection(options.args, 'verify');
  const checkout = await gitRoot(options.runner, options.root, 'verify');
  const selection = await resolveSelection(options.runner, checkout, request);
  const files = await changedFiles(options.runner, {
    cwd: checkout,
    command: 'verify',
    selection,
  });
  const facts = await (options.facts ?? readChangedFacts)(options.root);
  const selected = await (options.tests ?? appTestScope)(options.root, checkout, files);
  const plan = planChangedSteps(reRoot(checkout, options.root, files), facts);
  if (selected === undefined || selected.all) {
    return { selection, plan, tests: undefined, forcing: selected?.forcing ?? [] };
  }
  const discovered = await (options.discover ?? discoverAll)(options.root);
  const kept = narrowToApp(
    discovered.map((path) => ({ path })),
    options.root,
    selected,
  ).kept.map((file) => file.path);
  const narrowed = narrowSuites(plan, kept);
  return {
    selection,
    plan: narrowed.plan,
    tests: { scope: selected, whole: narrowed.whole, kept },
    forcing: [],
  };
}

/** `data.changed`: the base, every file with its rule, and every step with the files that chose it. */
export const changedScopeJson = (scope: ChangedScope): JsonValue => ({
  base: scope.selection.base,
  dirty: scope.selection.dirty,
  files: scope.plan.files.map((file) => ({ path: file.path, rule: file.rule })),
  steps: scope.plan.steps.map((step) => ({ name: step.name, files: [...step.files] })),
  tests:
    scope.tests === undefined
      ? { all: true, forcing: [...scope.forcing] }
      : { all: false, files: [...scope.tests.kept], whole: [...scope.tests.whole] },
});

/** How many files a human line names before it says `(+N)`. */
const SHOWN = 3;

/** One human line per selected step: `drift  ← packages/db/migrations/1.sql (+2)`. */
export const changedScopeLines = (scope: ChangedScope): readonly string[] =>
  scope.plan.steps.map((step) => {
    const shown = step.files.slice(0, SHOWN).join(', ');
    const more = step.files.length > SHOWN ? ` (+${step.files.length - SHOWN})` : '';
    return `  ${step.name.padEnd(14)}← ${shown}${more}`;
  });

/**
 * Whether this run is `--changed`. Refused beside `--only` — two narrowings, and whichever won
 * the other would be silently ignored — and `--base`/`--dirty` without it, which narrow nothing.
 */
export function readChangedRun(
  args: ParsedArgs,
  only: readonly VerifyStepName[] | undefined,
): boolean {
  const changed = flagBool(args, 'changed');
  if (changed && only !== undefined) {
    throw new BadFlagError({
      flag: 'changed',
      command: 'verify',
      reason: '--changed derives the step list from the diff and --only names one: pick one',
      fix: 'x verify --changed --json',
    });
  }
  if (!changed) {
    const stray =
      flagString(args, 'base') !== undefined
        ? 'base'
        : flagBool(args, 'dirty')
          ? 'dirty'
          : undefined;
    if (stray !== undefined) {
      throw new BadFlagError({
        flag: stray,
        command: 'verify',
        reason: `--${stray} scopes the diff --changed reads, and does nothing without it`,
        fix:
          stray === 'base'
            ? `x verify --changed --base ${renderFixShellArg(flagString(args, 'base'), '<ref>')} --json`
            : 'x verify --changed --dirty --json',
      });
    }
  }
  return changed;
}

/** `data.changed` and one line per chosen step, after whatever the run already reported. */
export const withChangedData = (result: CommandResult, scope: ChangedScope): CommandResult => ({
  ...result,
  lines: [...changedScopeLines(scope), ...(result.lines ?? [])],
  data: { ...((result.data ?? {}) as Record<string, JsonValue>), changed: changedScopeJson(scope) },
});
