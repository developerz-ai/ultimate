// Single responsibility: the `alter table … replica identity full` a live query needs, emitted once.
// `@ultimat3/realtime` refuses a subscription to a table without it — logical replication carries no
// old row on an UPDATE, so no patch can be computed — and which tables need it is a tier-3 fact no
// entity carries, so it arrives as `GenerateOptions.replicaIdentityFull` and is recorded on the
// snapshot: the record is what stops the statement being re-emitted on every `x db gen`.

import type { Plan } from './foreign-key-plan';
import { findTable, type SchemaDescription } from './introspect';
import { identifier } from './sql';

export interface ReplicaIdentityInput {
  /** Tables a live query subscribes to. Absent or empty emits nothing and reverts nothing. */
  readonly wanted: readonly string[] | undefined;
  /** The tables this migration leaves standing — the ALTER may name no other. */
  readonly declared: ReadonlySet<string>;
  /** Of those, the ones it CREATES: their whole `down` is already `drop table`. */
  readonly created: ReadonlySet<string>;
  /** What migrations already recorded — `expectedSchema(migrations, ledger)`. */
  readonly current: SchemaDescription;
}

/**
 * Whether the recorded schema already says this table carries it.
 *
 * Absent — never `false` — is a sidecar written before the field existed: it declares nothing, so
 * the ALTER is emitted once more against a table that may already have it, which Postgres accepts.
 * The opposite reading would be "recorded as not full", and a snapshot that predates the field
 * cannot mean that. `TableDescription.checks` states the same rule for the same reason.
 */
export function recordsReplicaIdentityFull(current: SchemaDescription, table: string): boolean {
  return findTable(current, table)?.replicaIdentityFull === true;
}

/** Which tables to record on the snapshot — sorted only by the caller's own table order. */
function pending(input: ReplicaIdentityInput): readonly string[] {
  // Deduplicated and sorted, so the same live-query set generates the same bytes whatever order the
  // manifest walked its queries in: a diff that moves a line is a diff an author has to read.
  return [...new Set(input.wanted ?? [])]
    .filter((table) => input.declared.has(table))
    .filter((table) => !recordsReplicaIdentityFull(input.current, table))
    .sort();
}

/**
 * The tables carrying it once this migration has applied — what `snapshotOf` records.
 *
 * The UNION with what is already recorded, never this run's set alone. A caller that passes no
 * live-query set (`x db gen` from a command that never learned about one) must not silently erase
 * the fact from the sidecar, or the very next run emits the ALTER again on a table that has it.
 */
export function replicaIdentityFullAfter(input: ReplicaIdentityInput): ReadonlySet<string> {
  const after = new Set<string>();
  for (const table of input.declared) {
    if (recordsReplicaIdentityFull(input.current, table)) after.add(table);
  }
  for (const table of pending(input)) after.add(table);
  return after;
}

/**
 * Additive only, and never destructive. `alter table … replica identity full` widens what logical
 * replication carries; it drops no row, rewrites no column and matches none of `destructive.ts`'s
 * four rules, so the migration it lands in needs no `-- destructive: true` marker.
 *
 * A name matching no entity is SKIPPED rather than refused: the list is derived from the manifest's
 * live queries, and a query whose entity has been deleted is an app fault the generator cannot
 * repair — emitting the statement anyway would be `42P01` at `ROLE=migrate`, which is the one place
 * this package refuses to put a fault.
 *
 * Nothing is ever reverted. A table dropping out of the live-query set keeps the identity it has:
 * the option is optional, so "absent" and "no live query subscribes any more" are the same value,
 * and reading them alike would let a caller that never passes the option turn off replication for
 * every subscribed table in the app.
 */
export function replicaIdentityPlan(plan: Plan, input: ReplicaIdentityInput): void {
  for (const table of pending(input)) {
    const name = identifier(table).text;
    plan.up.push(`alter table ${name} replica identity full;`);
    // A table this migration created is dropped by its own `down`; a second statement ahead of that
    // is a line an author reads and nothing performs.
    if (input.created.has(table)) continue;
    plan.down.push(`alter table ${name} replica identity default;`);
  }
}
