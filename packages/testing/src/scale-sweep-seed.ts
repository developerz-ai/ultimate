// The scale sweep's sized seed, written entity by entity: one table's refusal (a unique key, a check)
// is that table's, never the sweep's. Its rows, and every table that points at it, are skipped; the
// rest are written, so only a primitive that reads a lost table goes `unproven` (`readsLost`).

import { renderThrowable } from '@ultimat3/core';
import type { SentStatement } from './plan-sweep';
import type { SeedGraph, SeedRow, SeedWriter } from './seed-graph-plan';
import { entityRuns } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { statementTables } from './sql-tables';

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

/**
 * Each entity with no rows of its own whose source lost its rows: a view over a lost table (read
 * off its SQL, views over views too) and a history table whose parent is lost — the trigger writes
 * its rows from the parent's. Their reads are judged against rows the sized seed never wrote.
 */
const derivedLoss = (
  entities: readonly SeedEntity[],
  lost: ReadonlyMap<string, ScaleSeedFailure>,
): ReadonlyMap<string, ScaleSeedFailure> => {
  const byTable = new Map(entities.map((entity) => [entity.$table.toLowerCase(), entity.$name]));
  const all = new Map(lost);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entity of entities) {
      if (all.has(entity.$name)) continue;
      const described = entity.$describe();
      const sources = [
        ...(described.historyOf === undefined ? [] : [described.historyOf]),
        ...(described.view === undefined ? [] : statementTables(described.view.sql)).flatMap(
          (table) => byTable.get(table) ?? [],
        ),
      ];
      const failure = sources.map((source) => all.get(source)).find((one) => one !== undefined);
      if (failure === undefined) continue;
      all.set(entity.$name, failure);
      grew = true;
    }
  }
  return all;
};

/**
 * The lost table `subject` read in the pass — any statement it sent naming one in a table position
 * (`statementTables`: a column spelled like one is no read of it) — or none. Read off the room's
 * `sent()`: what a primitive's own call sent is what its sized call sends again.
 */
export function readsLost(
  subject: string,
  sent: ReadonlyMap<string, SentStatement>,
  loss: ScaleSeedLoss,
  entities: readonly SeedEntity[],
): ScaleSeedFailure | undefined {
  if (loss.lost.size === 0) return undefined;
  const lost = derivedLoss(entities, loss.lost);
  const tables = new Map(
    entities.flatMap((entity) => {
      const failure = lost.get(entity.$name);
      return failure === undefined ? [] : [[entity.$table.toLowerCase(), failure] as const];
    }),
  );
  for (const [text, statement] of sent) {
    if (!statement.primitives.has(subject)) continue;
    for (const table of statementTables(text)) {
      const failure = tables.get(table);
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}
