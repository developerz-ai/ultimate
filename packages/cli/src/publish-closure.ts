// `package-shape`'s other half of "a fixture does not ship": what a published package's ENTRY
// POINTS can load, held against the files its tarball leaves out. `files` negates
// `src/**/*-fixture.ts`, so a module an entry reaches under that suffix is a published package
// that fails on import — and the defect is the name, not the exclusion.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { ClosureHost } from './import-closure';
import { importClosure } from './import-closure';
import type { Finding } from './output';

/** The suffix `FIXTURE_EXCLUSION` removes from a tarball. */
export const FIXTURE_SUFFIX = '-fixture.ts';

/** A package directory, read by package-relative POSIX path. */
export type PackageReader = Pick<ClosureHost, 'read'>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** Every string under `exports` / `bin`, whatever the nesting: a condition map is still a file. */
const targetsOf = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  return isRecord(value) ? Object.values(value).flatMap(targetsOf) : [];
};

/**
 * The modules a consumer can import or run: `exports` and `bin`, package-relative. A subpath
 * pattern (`./icons/*`) names no one file and a stylesheet is not a module, so neither is an
 * entry to walk from.
 */
export function entryFilesOf(manifest: unknown): readonly string[] {
  if (!isRecord(manifest)) return [];
  const targets = [...targetsOf(manifest['exports']), ...targetsOf(manifest['bin'])];
  const files = targets
    .map((target) => target.replace(/^\.\//, ''))
    .filter((target) => /\.tsx?$/.test(target) && !target.includes('*'));
  return [...new Set(files)].sort();
}

/**
 * Every `*-fixture.ts` whose body an entry can run. Bare specifiers end the walk: another package
 * is that package's tarball, held by its own run of this rule.
 */
export function fixturesReachedFrom(
  reader: PackageReader,
  entries: readonly string[],
): readonly string[] {
  const host: ClosureHost = { read: reader.read, alias: () => undefined };
  return importClosure(host, entries).filter((path) => path.endsWith(FIXTURE_SUFFIX));
}

/** `src/a/driver-fixture.ts` → `driver-fixture`; an `index.ts` is named by its directory. */
const stemOf = (path: string): string => {
  const parts = path.replace(/\.tsx?$/, '').split('/');
  const last = parts.at(-1) ?? '';
  return last === 'index' ? (parts.at(-2) ?? last) : last;
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The cheap question, asked before the walk: COULD an entry reach a fixture? Backwards from each
 * fixture, by the last segment of a relative specifier, over text alone — so it over-answers (a
 * type-only import, two files of one name) and never under-answers. `false` is final; `true`
 * earns the real closure. Measured 2026-10: the closure alone was ~650 ms across the 12 packages
 * that hold a fixture, and all but one of them are answered here.
 */
export function mayReachFixture(
  sources: ReadonlyMap<string, string>,
  entries: readonly string[],
): boolean {
  const entrySet = new Set(entries);
  const seen = new Set<string>();
  let frontier = [...sources.keys()].filter((path) => path.endsWith(FIXTURE_SUFFIX));
  while (frontier.length > 0) {
    const names = new RegExp(
      `/(?:${frontier.map(stemOf).map(escaped).join('|')})(?:\\.[jt]sx?)?['"]`,
    );
    const next: string[] = [];
    for (const [path, text] of sources) {
      if (seen.has(path) || path.endsWith(FIXTURE_SUFFIX) || !names.test(text)) continue;
      if (entrySet.has(path)) return true;
      seen.add(path);
      next.push(path);
    }
    frontier = next;
  }
  return false;
}

export const fixtureReachFinding = (
  dir: string,
  fixture: string,
  entries: readonly string[],
): Finding => ({
  code: 'X_PACKAGE_SHAPE',
  cause: `packages/${dir}/${fixture} is loaded from the package's entry points (${entries.join(', ')}), and "files" leaves every *${FIXTURE_SUFFIX} out of the tarball — the published package would fail on import`,
  fix: `rename packages/${dir}/${fixture} so it does not end in ${FIXTURE_SUFFIX} — it is shipped source, not test code — and update the imports that name it`,
  docs: ERROR_DOCS_URL,
  at: `packages/${dir}/${fixture}`,
});
