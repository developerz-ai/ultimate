// The scale sweep's sized seed, written entity by entity: one table's refusal (a unique key, a check)
// is that table's, never the sweep's. Its rows, and every table that points at it, are skipped; the
// rest are written, so only a primitive that reads a lost table goes `unproven` (`readsLost`).

import { renderThrowable } from '@ultimat3/core';
import type { SentStatement } from './plan-sweep';
import type { SeedGraph, SeedRow, SeedWriter } from './seed-graph-plan';
import { entityRuns } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** One table the sized seed could not write: the entity, and the driver's words (the constraint). */
export interface ScaleSeedFailure {
  readonly entity: string;
  readonly table: string;
  readonly cause: string;
}

/** What the sized seed did not write: the tables that refused, and every table left without rows. */
export interface ScaleSeedLoss {
  readonly failures: readonly ScaleSeedFailure[];
  /** Entity name → the failure it lost its rows to: its own, or a referenced table's. */
  readonly lost: ReadonlyMap<string, ScaleSeedFailure>;
}

/** The failure a table pointing at a lost one inherits: the first of its references that is lost. */
const inherited = (
  entity: SeedEntity | undefined,
  lost: ReadonlyMap<string, ScaleSeedFailure>,
): ScaleSeedFailure | undefined => {
  for (const ref of entity?.$references() ?? []) {
    if (ref.targetEntity === entity?.$name) continue;
    const failure = lost.get(ref.targetEntity);
    if (failure !== undefined) return failure;
  }
  return undefined;
};

/**
 * Every graph, in order, one entity's run at a time. A run that throws marks its entity lost; a run
 * of a lost entity, or of one referencing a lost entity, is not sent (its keys point at nothing).
 */
export async function writeSizedSeeds(
  graphs: readonly SeedGraph[],
  entities: readonly SeedEntity[],
  writer: SeedWriter,
): Promise<ScaleSeedLoss> {
  const byName = new Map(entities.map((entity) => [entity.$name, entity]));
  const failures: ScaleSeedFailure[] = [];
  const lost = new Map<string, ScaleSeedFailure>();
  const attempt = async (entity: string, table: string, write: () => Promise<void>) => {
    if (lost.has(entity)) return;
    const from = inherited(byName.get(entity), lost);
    if (from !== undefined) {
      lost.set(entity, from);
      return;
    }
    try {
      await write();
    } catch (error) {
      const failure = { entity, table, cause: renderThrowable(error) };
      failures.push(failure);
      lost.set(entity, failure);
    }
  };
  for (const graph of graphs) {
    for (const run of entityRuns(graph.inserts)) {
      const [first] = run as readonly [SeedRow, ...SeedRow[]];
      await attempt(first.entity, first.table, async () => {
        if (writer.insertMany !== undefined) await writer.insertMany(run);
        else for (const row of run) await writer.insert(row);
      });
    }
    for (const update of graph.updates) {
      const table = byName.get(update.entity)?.$table ?? update.entity;
      await attempt(update.entity, table, () => writer.update(update));
    }
  }
  return { failures, lost };
}

/** `"posts"`, `posts.` or `posts ` — the table as an identifier, never inside a longer name. */
const WORD = /[A-Za-z0-9_]/;
const mentions = (text: string, table: string): boolean => {
  for (let at = text.indexOf(table); at !== -1; at = text.indexOf(table, at + 1)) {
    const before = text[at - 1];
    const after = text[at + table.length];
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after)))
      return true;
  }
  return false;
};

/**
 * The lost table `subject` read in the pass — any statement it sent naming one — or none. Read off
 * the room's `sent()`: what a primitive's own call sent is what its sized call sends again.
 */
export function readsLost(
  subject: string,
  sent: ReadonlyMap<string, SentStatement>,
  loss: ScaleSeedLoss,
  entities: readonly SeedEntity[],
): ScaleSeedFailure | undefined {
  if (loss.lost.size === 0) return undefined;
  const tables = entities.flatMap((entity) => {
    const failure = loss.lost.get(entity.$name);
    return failure === undefined ? [] : [[entity.$table, failure] as const];
  });
  for (const [text, statement] of sent) {
    if (!statement.primitives.has(subject)) continue;
    for (const [table, failure] of tables) if (mentions(text, table)) return failure;
  }
  return undefined;
}
