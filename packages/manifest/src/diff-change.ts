// The vocabulary every classifier in the `diff-*` family speaks: one change, its three kinds, and
// the two shapes every section needs — an index by name and a flat set difference.
//
//   breaking  — an existing consumer stops working (a removal, a tightened input, a changed
//               output, a new or changed policy, a newly REQUIRED permission, a tightened rate
//               limit — anything that already shipped and now refuses a caller it served)
//   additive  — a new capability; nothing that worked stops working
//   internal  — visible in the file but not in the contract (a description, a cache tag, the
//               buildId itself)

export type ChangeKind = 'breaking' | 'additive' | 'internal';

export interface ManifestChange {
  readonly kind: ChangeKind;
  /** Dotted path into the manifest, e.g. `actions.publishPost.policy`. */
  readonly path: string;
  readonly detail: string;
}

export function index<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

/**
 * A flat set of names: what left, what arrived. `removalKind` is the only thing that differs
 * between sections — a locale disappearing is additive, a permission disappearing is not.
 */
export function diffNamedSet(
  path: string,
  before: readonly string[],
  after: readonly string[],
  removalKind: ChangeKind = 'breaking',
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  for (const name of before) {
    if (!afterSet.has(name)) {
      changes.push({ kind: removalKind, path: `${path}.${name}`, detail: 'removed' });
    }
  }
  for (const name of after) {
    if (!beforeSet.has(name)) {
      changes.push({ kind: 'additive', path: `${path}.${name}`, detail: 'added' });
    }
  }
  return changes;
}

/**
 * One scalar field, compared only where BOTH sides carry a value.
 *
 * `before` is a file parsed off disk, so an optional field a manifest was written before is
 * absent rather than wrong — and reading absence as a value reports every route in an upgraded
 * app as newly re-surfaced. Absence is no evidence, the same rule `permissions` already follows.
 */
export function diffScalar(
  kind: ChangeKind,
  path: string,
  before: unknown,
  after: unknown,
  detail = (from: string, to: string): string => `${from} -> ${to}`,
): readonly ManifestChange[] {
  if (before === undefined || after === undefined || before === null || after === null) return [];
  if (before === after) return [];
  return [{ kind, path, detail: detail(String(before), String(after)) }];
}
