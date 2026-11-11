// Single responsibility: `changelog-check`'s GUARD-REFRESH rule, pure. A shipped guard template
// that changed between two releases reaches an app only through `x g guard <name> --force` (the
// app's `guards/` copy is its own; `x upgrade` never rewrites it), so wiki/Upgrading.md must say
// so, per guard, in a row naming that release. 31.4.0 and 31.4.1 changed twelve and said nothing.

export const GUARD_TEMPLATE_DIR = 'packages/cli/src/templates';
export const GUARD_REFRESH_PAGE = 'wiki/Upgrading.md';

/** `packages/cli/src/templates/guard-<stem>.ts`, never its test: the test is the framework's own. */
const TEMPLATE_FILE = /^packages\/cli\/src\/templates\/guard-([a-z0-9-]+)\.ts$/;

/** One release range's changed guards: `to` undefined is `[Unreleased]`, the tree past `from`. */
export interface GuardChange {
  readonly from: string;
  readonly to: string | undefined;
  readonly guards: readonly string[];
}

/**
 * The shipped guards a list of changed paths touches. A changed module that is no shipped guard is a
 * helper spliced into guards (`guard-local-binding.ts`): it changes every guard that imports it —
 * `importers(stem)` names them. A stem that is neither (a guard since deleted) changes nothing an
 * app can refresh.
 */
export function changedGuards(
  paths: readonly string[],
  shipped: readonly string[],
  importers: (stem: string) => readonly string[],
): readonly string[] {
  const changed = new Set<string>();
  for (const path of paths) {
    const stem = TEMPLATE_FILE.exec(path.trim())?.[1];
    if (stem === undefined) continue;
    if (shipped.includes(stem)) changed.add(stem);
    else for (const name of importers(stem)) if (shipped.includes(name)) changed.add(name);
  }
  return [...changed].sort();
}

/** One unit of the page a reader takes as one statement: a table row, a list item, a paragraph. */
export interface PageUnit {
  readonly line: number;
  readonly text: string;
}

export function pageUnits(page: string): readonly PageUnit[] {
  const units: PageUnit[] = [];
  let open: { line: number; lines: string[] } | undefined;
  const close = (): void => {
    if (open !== undefined) units.push({ line: open.line, text: open.lines.join(' ') });
    open = undefined;
  };
  for (const [index, text] of page.split('\n').entries()) {
    if (text.trim() === '' || text.startsWith('#')) {
      close();
      continue;
    }
    if (text.startsWith('|') || /^\s*(?:[-*]|\d+\.)\s/.test(text)) close();
    if (open === undefined) open = { line: index + 1, lines: [] };
    open.lines.push(text);
    if (text.startsWith('|')) close();
  }
  close();
  return units;
}

const REFRESH = /\bx g guard\b/;

/** `X.Y.Z` order, numerically: every version this rule reads is a release, never a prerelease. */
export const compareVersions = (a: string, b: string): number => {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) {
    const delta = (left?.[index] ?? 0) - (right?.[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};
const VERSION = /\b\d+\.\d+\.\d+\b/g;

/** Whether a version named in the unit is one this range ships: `from < v ≤ to`, or `v > from`. */
const namesRange = (text: string, change: GuardChange): boolean =>
  (text.match(VERSION) ?? []).some(
    (version) =>
      compareVersions(version, change.from) > 0 &&
      (change.to === undefined || compareVersions(version, change.to) <= 0),
  );

const namesGuard = (text: string, guard: string): boolean =>
  new RegExp(`(?<![\\w-])${guard}(?![\\w-])`).test(text);

/** The guards of `change` no unit names together with `x g guard` and a version of the range. */
export function unstatedGuards(change: GuardChange, page: string): readonly string[] {
  const units = pageUnits(page).filter(
    (unit) => REFRESH.test(unit.text) && namesRange(unit.text, change),
  );
  return change.guards.filter((guard) => !units.some((unit) => namesGuard(unit.text, guard)));
}

export interface GuardRefreshGap {
  readonly change: GuardChange;
  readonly missing: readonly string[];
}

export function guardRefreshGaps(
  changes: readonly GuardChange[],
  page: string,
): readonly GuardRefreshGap[] {
  return changes
    .map((change) => ({ change, missing: unstatedGuards(change, page) }))
    .filter((gap) => gap.missing.length > 0);
}
