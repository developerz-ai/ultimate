// `--affected` inside an app root: the test files a diff can break, by import closure. Every slice
// of an app shares `apps/web`, so the workspace answer (`affected.ts`) runs the whole app there;
// `selectTests` is the one rule that narrows further, and this file only maps paths onto it.

// why: Bun ships no path API; git reports paths from the checkout root, discovery from the cwd.
import { join, relative, resolve } from 'node:path';
import type { TestSelection } from './app-module-graph';
import { moduleFiles, selectTests } from './app-module-graph';
import { findAppRoot } from './app-root';
import type { JsonValue } from './output';

export interface AppTestScope extends TestSelection {
  /** The app root, absolute: `tests` and `known` are relative to it. */
  readonly app: string;
  /** Every test file the module graph read, selected or not. */
  readonly known: readonly string[];
  /** How many changed files the selection was asked about. */
  readonly changed: number;
}

const toPosix = (path: string): string => path.replace(/\\/g, '/');

/**
 * `selectTests` over the app `cwd` sits in, the diff re-rooted from the checkout onto the app. A
 * changed file outside the app comes back `../…`, which `selectTests` already counts as forcing.
 * `undefined` outside an app: a package monorepo's unit is the workspace.
 */
export async function appTestScope(
  cwd: string,
  checkout: string,
  changed: readonly string[],
): Promise<AppTestScope | undefined> {
  const found = findAppRoot(cwd);
  if (found === undefined) return undefined;
  const app = resolve(found.dir);
  const inApp = changed.map((path) => toPosix(relative(app, join(resolve(checkout), path))));
  const files = await moduleFiles(app);
  return {
    app,
    known: files.filter((file) => file.test).map((file) => file.path),
    changed: changed.length,
    ...selectTests(files, inApp),
  };
}

/**
 * Why a file runs: its import closure meets the diff, a changed file forced every test, or the
 * module graph never read it.
 */
type Why = 'closure' | 'all' | 'unmapped';

export interface AppNarrowing<T> {
  readonly kept: readonly T[];
  /** `data.affected.tests` for `--json`: what was selected, and why. */
  readonly json: JsonValue;
}

/**
 * The discovered files (relative to `cwd`) narrowed to the selection. A discovered test the graph
 * never read — outside the globs `moduleFiles` scans — is KEPT: the graph cannot say it is safe
 * to skip, and a skipped test the diff broke is a green run over a broken app.
 */
export function narrowToApp<T extends { readonly path: string }>(
  discovered: readonly T[],
  cwd: string,
  scope: AppTestScope,
): AppNarrowing<T> {
  const selected = new Set(scope.tests);
  const known = new Set(scope.known);
  const kept: T[] = [];
  const files: { readonly path: string; readonly why: Why }[] = [];
  for (const file of discovered) {
    const inApp = toPosix(relative(scope.app, join(resolve(cwd), file.path)));
    const why: Why | undefined = !known.has(inApp)
      ? 'unmapped'
      : scope.all
        ? 'all'
        : selected.has(inApp)
          ? 'closure'
          : undefined;
    if (why === undefined) continue;
    kept.push(file);
    files.push({ path: file.path, why });
  }
  return {
    kept,
    json: {
      app: scope.app,
      all: scope.all,
      reason: scope.all
        ? `all: ${scope.forcing.join(', ')}`
        : `closure: ${scope.changed} changed file(s)`,
      forcing: [...scope.forcing],
      files,
    },
  };
}
