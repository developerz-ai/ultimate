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
    changes.push(...diffDefault(`${at}.hasDefault`, column.hasDefault === true, next));
    changes.push(...diffKey(at, 'primaryKey', keyOf(column), keyOf(next)));
    changes.push(...diffKey(at, 'references', column.references, next.references));
    changes.push(...diffSealed(`${at}.sealed`, column.sealed, next.sealed));
  }

  const beforeColumns = index(before.columns, (c) => c.name);
  for (const column of after.columns) {
    if (!beforeColumns.has(column.name)) {
      // A default is what makes a NOT NULL column safe to add: every existing row takes it and no
      // writer that omits the column is refused.
      const additive = column.nullable || column.hasDefault === true;
      changes.push({
        kind: additive ? 'additive' : 'breaking',
        path: `${path}.columns.${column.name}`,
        detail: column.nullable
          ? 'column added'
          : additive
            ? 'column added with a default'
            : 'NOT NULL column added with no default',
      });
    }
  }
  return changes;
}

/**
 * A declared default on a column that was already there. It was read for an ADDED column only, so
 * a NOT NULL column losing its default reported nothing but `buildId` — while every writer that
 * omits the column is refused from then on. Dropped from a nullable column, an omitted value
 * becomes NULL instead: nobody is refused, but the stored meaning moved. Gaining one only widens.
 */
function diffDefault(
  path: string,
  had: boolean,
  next: EntityFact['columns'][number],
): readonly ManifestChange[] {
  const has = next.hasDefault === true;
  if (had === has) return [];
  if (has) return [{ kind: 'additive', path, detail: 'default added' }];
  return [
    next.nullable
      ? { kind: 'internal', path, detail: 'default dropped; an omitted value is now NULL' }
      : { kind: 'breaking', path, detail: 'default dropped; a writer that omits it is refused' },
  ];
}

/**
 * How a column is sealed is a WIRE fact as much as a storage one: `.sealed()` emits no DDL and
 * leaves the column's type alone, so nothing else in the file moves — while the field leaves every
 * action output, query row, record and live frame the app sends. Absence is a statement here, not
 * missing evidence: the field is written only for a sealed column, and a manifest older than the
 * feature had none.
 *
 * Three of the four moves break a consumer. Sealing removes a field every client read. Unsealing
 * puts it back AND leaves every stored value a ciphertext no read opens any more. `lookup` to
 * opaque refuses the equality filters and the unique rule that were legal. Opaque to `lookup` is
 * the one that only widens — reported all the same, because equal values now store equal strings,
 * and rows written before are found only once they are re-sealed.
 */
function diffSealed(
  path: string,
  before: ColumnFact['sealed'],
  after: ColumnFact['sealed'],
): readonly ManifestChange[] {
  if (before === after) return [];
  if (before === undefined) {
    return [
      {
        kind: 'breaking',
        path,
        detail: `became sealed (${after}); the field is removed from every output`,
      },
    ];
  }
  if (after === undefined) {
    return [
      {
        kind: 'breaking',
        path,
        detail:
          'no longer sealed; stored values stay ciphertext until rewritten, and the field joins every output',
      },
    ];
  }
  return after === 'lookup'
    ? [
        {
          kind: 'additive',
          path,
          detail:
            'sealed opaque -> lookup; equal values now store equal strings, and existing rows match only after a re-seal',
        },
      ]
    : [
        {
          kind: 'breaking',
          path,
          detail:
            'sealed lookup -> opaque; an equality filter or a unique rule on it is now refused',
        },
      ];
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
