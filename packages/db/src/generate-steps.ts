// Single responsibility: turn one diff into the migration FILES it needs — one transactional step,
// one non-transactional step, or the first followed by the second. Split from `generate.ts`, which
// plans the statements; this file decides which step each list is and what each step records.

import { NO_TRANSACTION_MARKER } from './concurrent-index';
import { type ConcurrentPlan, intermediateSnapshot } from './concurrent-plan';
import { isDestructiveMigration } from './destructive';
import type { GeneratedMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { type UnrenderedDeclaration, unrenderedComment } from './unrendered';

export interface DiffSteps {
  readonly id: string;
  readonly name: string;
  /** The transactional step's statements, in apply order. */
  readonly up: readonly string[];
  /** Its reversal, already in apply order. */
  readonly down: readonly string[];
  /** Everything that must run outside a transaction, after `up`. */
  readonly concurrent: ConcurrentPlan;
  /** The schema the whole diff leaves behind. */
  readonly snapshot: SchemaDescription;
  readonly unrendered: readonly UnrenderedDeclaration[];
}

/** One file's worth. `destructive` is read off `up` by the gate's own classifier, never assembled. */
function migrationOf(
  fields: Omit<GeneratedMigration, 'fileName' | 'destructive' | 'followUp'>,
): GeneratedMigration {
  return {
    ...fields,
    fileName: `migrations/${fields.id}.sql`,
    destructive: isDestructiveMigration(fields.up),
  };
}

/**
 * The step files of one diff.
 *
 * The unrendered report sits at the TOP of the first step's `up` and never onto an empty one:
 * `@ultimat3/cli`'s `generateAppMigration` reads an empty `up` as "nothing changed". In a
 * non-transactional step the marker comes first — it is the header line the runner reads.
 *
 * Why TWO files and never one file in two halves: a migration is one ledger row. A file whose
 * transactional half committed and whose concurrent half then failed is either recorded (and the
 * index never built) or not (and the next run re-applies the committed half: `42P07`). Two files
 * are two rows, and the second is idempotent by construction (`if not exists` / `if exists`, an
 * INVALID leftover dropped first), so a failure in it is re-run, never repaired by hand.
 */
export function assembleSteps(diff: DiffSteps): GeneratedMigration {
  const { id, name, snapshot, unrendered } = diff;
  const body = diff.up.join('\n');
  const later = diff.concurrent.up.join('\n');
  const laterDown = [...diff.concurrent.down].reverse().join('\n');
  const outside = (report: readonly UnrenderedDeclaration[]): string =>
    `${NO_TRANSACTION_MARKER}\n${unrenderedComment(report)}${later}`;
  if (body.length === 0 && later.length > 0) {
    // Only index work: the non-transactional step IS the migration, under the plain id.
    return migrationOf({
      id,
      name,
      up: outside(unrendered),
      down: laterDown,
      snapshot,
      unrendered,
      transactional: false,
    });
  }
  const first = migrationOf({
    id,
    name,
    up: body.length === 0 ? body : unrenderedComment(unrendered) + body,
    down: diff.down.join('\n'),
    // What the transactional step alone leaves behind, when a second one follows it.
    snapshot:
      later.length === 0 ? snapshot : intermediateSnapshot(snapshot, diff.concurrent.deferred),
    unrendered,
    transactional: true,
  });
  if (later.length === 0) return first;
  // `_concurrently` sorts right after the plain id — as a ledger id, an `.sql` and every sidecar —
  // so expand (the transaction) always lands before contract (the concurrent drops).
  const followUp = migrationOf({
    id: `${id}_concurrently`,
    name: `${name} concurrently`,
    up: outside([]),
    down: laterDown,
    snapshot,
    unrendered: [],
    transactional: false,
  });
  return { ...first, followUp };
}
