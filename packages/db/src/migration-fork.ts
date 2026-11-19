// Single responsibility: is this migration chain two branches' work merged side by side, and what
// schema does it really build? No database: the sidecars and the `up` text answer it.
//
// `x db gen` diffs against the newest sidecar, so two branches generated from one parent each write
// a sidecar that has never heard of the other's work. Every `.sql` stays valid; only the newest
// sidecar is wrong. Taking it at its word made `drift` ask for a second `create table`.

import type { SchemaDescription } from './introspect';
import { apply, byName, type Fold, key, overlay, partsOf } from './migration-fork-fold';
import { forkEventsOf } from './migration-fork-sql';
import type { Migration } from './migration-ledger';

export type ForkObjectKind = 'table' | 'column' | 'index' | 'foreign key' | 'check' | 'view';

/** Built by the chain, missing from the newest sidecar. */
export interface ForkLoss {
  readonly kind: ForkObjectKind;
  readonly table: string;
  readonly name: string;
  readonly recordedBy: string;
}

/** Dropped by the chain, still in the newest sidecar. */
export interface ForkStale {
  readonly kind: 'table' | 'column';
  readonly table: string;
  readonly name: string;
  readonly droppedBy: string;
}

/** Created twice with no guard: `again` fails on any database that ran `first`. */
export interface ForkCollision {
  readonly kind: 'table' | 'column';
  readonly table: string;
  readonly name: string;
  readonly first: string;
  readonly again: string;
}

export interface MigrationFork {
  readonly newest: string;
  /** What the chain builds: the sidecar the newest migration should have written. */
  readonly merged: SchemaDescription;
  readonly lost: readonly ForkLoss[];
  readonly stale: readonly ForkStale[];
  readonly collisions: readonly ForkCollision[];
}

function lostFrom(fold: Fold, newest: SchemaDescription, newestId: string): readonly ForkLoss[] {
  const recordedBy = (kind: ForkObjectKind, table: string, name: string): string =>
    fold.recordedBy.get(key(kind, table, name)) ?? newestId;
  const recorded = new Map(newest.tables.map((table) => [table.name, table]));
  const lost: ForkLoss[] = [];
  for (const table of [...fold.tables.values()].sort(byName)) {
    const stated = recorded.get(table.name);
    if (stated === undefined) {
      const by = recordedBy('table', table.name, table.name);
      lost.push({ kind: 'table', table: table.name, name: table.name, recordedBy: by });
      continue;
    }
    const statedParts = partsOf(stated);
    partsOf(table).forEach(([kind, items], index) => {
      const names = new Set((statedParts[index]?.[1] ?? []).map((item) => item.name));
      for (const item of items) {
        if (names.has(item.name)) continue;
        const by = recordedBy(kind, table.name, item.name);
        lost.push({ kind, table: table.name, name: item.name, recordedBy: by });
      }
    });
  }
  const views = new Set((newest.views ?? []).map((view) => view.name));
  for (const view of [...fold.views.values()].sort(byName)) {
    if (views.has(view.name)) continue;
    const by = recordedBy('view', view.name, view.name);
    lost.push({ kind: 'view', table: view.name, name: view.name, recordedBy: by });
  }
  return lost;
}

function staleFrom(fold: Fold, newest: SchemaDescription): readonly ForkStale[] {
  const stale: ForkStale[] = [];
  for (const table of newest.tables) {
    const droppedTable = fold.gone.get(key('table', table.name, table.name));
    if (droppedTable !== undefined) {
      const name = table.name;
      stale.push({ kind: 'table', table: name, name, droppedBy: droppedTable });
      continue;
    }
    for (const column of table.columns) {
      const droppedBy = fold.gone.get(key('column', table.name, column.name));
      if (droppedBy === undefined) continue;
      stale.push({ kind: 'column', table: table.name, name: column.name, droppedBy });
    }
  }
  return stale;
}

/**
 * The fork in `migrations`, or `undefined` for a chain that agrees with itself.
 *
 * A fold over the chain: every sidecar adds what it records, every `up` removes what it drops.
 * What survives is what a replay builds, so it needs no record of which branch wrote what, and a
 * loss a later sidecar restored is no loss. A migration with no sidecar was written by hand and may
 * do anything, so what earlier sidecars claim ends there. A newest one with no sidecar is
 * `X_MIGRATION_SNAPSHOT_MISSING`'s, and answers `undefined` here.
 */
export function migrationFork(migrations: readonly Migration[]): MigrationFork | undefined {
  const ordered = [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1));
  const newest = ordered.at(-1);
  if (newest?.snapshot === undefined) return undefined;
  const fold: Fold = {
    tables: new Map(),
    views: new Map(),
    recordedBy: new Map(),
    gone: new Map(),
    collisions: [],
  };
  for (const migration of ordered) {
    if (migration.snapshot === undefined) {
      fold.tables.clear();
      fold.views.clear();
      fold.gone.clear();
      fold.recordedBy.clear();
      continue;
    }
    for (const event of forkEventsOf(migration.up)) apply(fold, event, migration.id);
    overlay(fold, migration.snapshot, migration.id);
  }
  const lost = lostFrom(fold, newest.snapshot, newest.id);
  const stale = staleFrom(fold, newest.snapshot);
  if (lost.length === 0 && stale.length === 0 && fold.collisions.length === 0) return undefined;
  const views = [...fold.views.values()].sort(byName);
  return {
    newest: newest.id,
    merged: {
      tables: [...fold.tables.values()].sort(byName),
      ...(views.length === 0 ? {} : { views }),
    },
    lost,
    stale,
    collisions: fold.collisions,
  };
}
