// The data shape: which table an entity maps to, what its columns promise, and which rules the
// database itself enforces. The axis is the same one `nullable` already uses — a change that
// rejects something previously valid is breaking; one that accepts more is additive and reported.

import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { ColumnFact, EntityFact } from './schema';

export function diffEntities(
  before: readonly EntityFact[],
  after: readonly EntityFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (e) => e.name);
  const beforeByName = index(before, (e) => e.name);

  for (const entity of before) {
    const next = afterByName.get(entity.name);
    const path = `entities.${entity.name}`;
    if (next === undefined) {
      changes.push({ kind: 'breaking', path, detail: 'entity removed' });
      continue;
    }
    // The table is the name every hand-written query, view and migration outside the app uses;
    // a rename leaves the entity intact in the manifest and every one of them broken.
    changes.push(
      ...diffScalar(
        'breaking',
        `${path}.table`,
        entity.table,
        next.table,
        (from, to) => `table ${from} -> ${to}`,
      ),
    );
    changes.push(...diffColumns(path, entity, next));
    changes.push(...diffInvariants(`${path}.invariants`, entity.invariants, next.invariants));
  }
  for (const entity of after) {
    if (!beforeByName.has(entity.name)) {
      changes.push({ kind: 'additive', path: `entities.${entity.name}`, detail: 'entity added' });
    }
  }
  return changes;
}

/**
 * An invariant is a CHECK or UNIQUE the database itself enforces, so the direction decides:
 * adding one rejects rows that were valid a moment ago, dropping one only widens what the table
 * accepts. Both are reported — a rule that quietly stopped being enforced is what a reviewer of a
 * data migration most needs to see.
 */
function diffInvariants(
  path: string,
  before: readonly string[],
  after: readonly string[],
): readonly ManifestChange[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after
      .filter((name) => !beforeSet.has(name))
      .map((name) => ({
        kind: 'breaking' as const,
        path: `${path}.${name}`,
        detail: 'invariant added; rows that were valid are now rejected',
      })),
    ...before
      .filter((name) => !afterSet.has(name))
      .map((name) => ({
        kind: 'additive' as const,
        path: `${path}.${name}`,
        detail: 'invariant removed; the rule is no longer enforced',
      })),
  ];
}

function diffColumns(
  path: string,
  before: EntityFact,
  after: EntityFact,
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const nextColumns = index(after.columns, (c) => c.name);

  for (const column of before.columns) {
    const next = nextColumns.get(column.name);
    const at = `${path}.columns.${column.name}`;
    if (next === undefined) {
      changes.push({ kind: 'breaking', path: at, detail: 'column removed' });
      continue;
    }
    if (column.type !== next.type) {
      changes.push({
        kind: 'breaking',
        path: `${at}.type`,
        detail: `${column.type} -> ${next.type}`,
      });
    }
    if (column.nullable !== next.nullable) {
      // Both directions, the axis this file's header declares and `diffInvariants` already
      // implements: tightening rejects rows that were valid a moment ago, loosening only widens
      // what the table accepts — and a constraint that quietly stopped being enforced is what a
      // reviewer of a data migration most needs to see. Only the tightening half was here, so
      // dropping NOT NULL reported nothing at all.
      changes.push(
        next.nullable
          ? { kind: 'additive', path: `${at}.nullable`, detail: 'became nullable' }
          : { kind: 'breaking', path: `${at}.nullable`, detail: 'became NOT NULL' },
      );
    }
    changes.push(...diffKey(at, 'primaryKey', keyOf(column), keyOf(next)));
    changes.push(...diffKey(at, 'references', column.references, next.references));
  }

  const beforeColumns = index(before.columns, (c) => c.name);
  for (const column of after.columns) {
    if (!beforeColumns.has(column.name)) {
      changes.push({
        kind: column.nullable ? 'additive' : 'breaking',
        path: `${path}.columns.${column.name}`,
        detail: column.nullable ? 'column added' : 'NOT NULL column added with no default',
      });
    }
  }
  return changes;
}

/** `primaryKey` is optional in the file, so absence is the same statement as `false`. */
const keyOf = (column: ColumnFact): string => (column.primaryKey === true ? 'yes' : 'no');

/**
 * Identity and relationship, in either direction. Gaining one rejects rows that used to insert;
 * losing one strands every consumer that navigated the graph the manifest published — a foreign
 * key is how an agent knows `authorId` reaches `users`, and nothing else in the file says so.
 */
function diffKey(
  at: string,
  field: 'primaryKey' | 'references',
  before: string | undefined,
  after: string | undefined,
): readonly ManifestChange[] {
  const from = before ?? 'none';
  const to = after ?? 'none';
  if (from === to) return [];
  return [{ kind: 'breaking', path: `${at}.${field}`, detail: `${field} ${from} -> ${to}` }];
}
