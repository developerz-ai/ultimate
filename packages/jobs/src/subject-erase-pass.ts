// One `subjectErase()` pass: the framework targets first (they read the subject's row), then every
// loop-closing key cleared, then each table children first, the subject last — a deleted table's
// step also purging the images its `set null`/`cascade` wrote into a child's history.
//
// Every page of parent keys is its own step, so a killed run resumes at the page it stopped on;
// each statement is an equality on one key, so a replayed step deletes or overwrites nothing twice.

import type { StepApi } from './steps-api';
import type { SubjectRef, SubjectTarget, SubjectTargetEntry } from './subject';
import { isRetainedTarget } from './subject';
import { type HistoryPage, treatPageWithHistory } from './subject-erase-history';
import type { SubjectStep } from './subject-plan';
import type { SubjectReader } from './subject-select';
import { rowIdentity } from './subject-select';

/** What one table or target went through. Bounded and JSON-safe: it is the job's result. */
export interface SubjectTally {
  readonly deleted: number;
  readonly anonymized: number;
  readonly retained: number;
}

export interface SubjectEraseReport {
  readonly tables: Readonly<Record<string, SubjectTally>>;
}

const tally = (deleted: number, anonymized: number, retained: number): SubjectTally => ({
  deleted,
  anonymized,
  retained,
});

/** The subject as a target reads it, fresh: its row is never written into a checkpoint. */
const refOf = async (reader: SubjectReader): Promise<SubjectRef> => ({
  key: reader.key,
  row: (await reader.rootRow()) ?? {},
});

async function eraseTarget(step: StepApi, reader: SubjectReader, target: SubjectTarget) {
  let total = 0;
  for (let n = 0; ; n += 1) {
    const removed = await step.run(`target:${target.name}:${n}`, async () =>
      target.erase(await refOf(reader), reader.size),
    );
    total += removed;
    if (removed < reader.size) return total;
  }
}

/** One write per parent key in the page: `deleteWhere`/`updateWhere`, the repository's own. */
async function treatPage(
  reader: SubjectReader,
  step: SubjectStep,
  property: string,
  values: readonly unknown[],
): Promise<number> {
  const table = reader.table(step.entity);
  let count = 0;
  for (const value of values) {
    const filter = { [property]: value };
    count +=
      step.treatment === 'delete'
        ? await table.deleteWhere(filter)
        : typeof step.treatment === 'object' && 'anonymize' in step.treatment
          ? await table.updateWhere(filter, step.treatment.anonymize)
          : 0;
  }
  return count;
}

async function countRows(reader: SubjectReader, entity: string): Promise<number> {
  const core = reader.core(entity);
  const seen = new Set<string>();
  for await (const page of reader.pages(entity)) {
    for (const row of page) seen.add(rowIdentity(core, row));
  }
  return seen.size;
}

/** One table's tally, and the rows removed from each history its step purges. */
interface TableErased {
  readonly own: SubjectTally;
  readonly history: Readonly<Record<string, number>>;
}

/** One page of parent keys: the table's own write, and with a history, that history's rows. */
const treat = async (
  reader: SubjectReader,
  step: SubjectStep,
  property: string,
  values: readonly unknown[],
): Promise<HistoryPage> => {
  if (step.history === undefined && step.orphans === undefined) {
    return { treated: await treatPage(reader, step, property, values), history: {} };
  }
  return treatPageWithHistory(reader, step, property, values);
};

async function eraseTable(
  stepApi: StepApi,
  reader: SubjectReader,
  step: SubjectStep,
): Promise<TableErased> {
  const { entity, treatment } = step;
  if (typeof treatment === 'object' && 'retain' in treatment) {
    const kept = await stepApi.run(`retain:${entity}`, () => countRows(reader, entity));
    return { own: tally(0, 0, kept), history: {} };
  }
  let count = 0;
  // A Map, never a `Record` read by a table name: `history['constructor']` answers a function.
  const history = new Map<string, number>();
  const add = (page: HistoryPage): void => {
    count += page.treated;
    for (const [table, n] of Object.entries(page.history)) {
      history.set(table, (history.get(table) ?? 0) + n);
    }
  };
  if (entity === reader.plan.subject) {
    add(
      await stepApi.run(`${entity}:subject`, () =>
        treat(reader, step, reader.plan.key, [reader.key]),
      ),
    );
  }
  for (const via of step.via) {
    let n = 0;
    for await (const values of reader.parentKeys(via)) {
      add(
        await stepApi.run(`${entity}.${via.property}:${n}`, () =>
          treat(reader, step, via.property, values),
        ),
      );
      n += 1;
    }
  }
  const own = treatment === 'delete' ? tally(count, 0, 0) : tally(0, count, 0);
  // A table's own history is reported even at zero: the plan declared it, the erase reached it.
  if (step.history !== undefined && !history.has(step.history)) history.set(step.history, 0);
  return { own, history: Object.fromEntries(history) };
}

export async function subjectErasePass(
  stepApi: StepApi,
  reader: SubjectReader,
  targets: readonly SubjectTargetEntry[],
): Promise<SubjectEraseReport> {
  const tables = new Map<string, SubjectTally>();
  for (const entry of targets) {
    if (isRetainedTarget(entry)) {
      tables.set(entry.target.name, tally(0, 0, 0));
      continue;
    }
    tables.set(entry.name, tally(await eraseTarget(stepApi, reader, entry), 0, 0));
  }
  for (const unlink of reader.plan.unlink) {
    let n = 0;
    for await (const values of reader.parentKeys(unlink)) {
      await stepApi.run(`unlink:${unlink.entity}.${unlink.property}:${n}`, async () => {
        const table = reader.table(unlink.entity);
        for (const value of values) {
          await table.updateWhere({ [unlink.property]: value }, { [unlink.property]: null });
        }
        return null;
      });
      n += 1;
    }
  }
  for (const step of reader.plan.steps) {
    const erased = await eraseTable(stepApi, reader, step);
    tables.set(step.entity, erased.own);
    // Summed: an orphan's history is purged again by each parent whose delete wrote into it.
    for (const [table, n] of Object.entries(erased.history)) {
      tables.set(table, tally((tables.get(table)?.deleted ?? 0) + n, 0, 0));
    }
  }
  return { tables: Object.fromEntries(tables) };
}
