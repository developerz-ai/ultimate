// One `subjectErase()` pass: the framework targets first (they read the subject's row), then every
// loop-closing key cleared, then each table children first, the subject last. Every page of
// parent keys is its own step, so a killed run resumes at the page it stopped on; each statement
// is an equality on one key, so a replayed step deletes or overwrites nothing twice.

import type { StepApi } from './steps-api';
import type { SubjectRef, SubjectTarget, SubjectTargetEntry } from './subject';
import { isRetainedTarget } from './subject';
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

async function eraseTable(
  stepApi: StepApi,
  reader: SubjectReader,
  step: SubjectStep,
): Promise<SubjectTally> {
  const { entity, treatment } = step;
  if (typeof treatment === 'object' && 'retain' in treatment) {
    return tally(0, 0, await stepApi.run(`retain:${entity}`, () => countRows(reader, entity)));
  }
  let count = 0;
  if (entity === reader.plan.subject) {
    count = await stepApi.run(`${entity}:subject`, () =>
      treatPage(reader, step, reader.plan.key, [reader.key]),
    );
  }
  for (const via of step.via) {
    let n = 0;
    for await (const values of reader.parentKeys(via)) {
      count += await stepApi.run(`${entity}.${via.property}:${n}`, () =>
        treatPage(reader, step, via.property, values),
      );
      n += 1;
    }
  }
  return treatment === 'delete' ? tally(count, 0, 0) : tally(0, count, 0);
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
    tables.set(step.entity, await eraseTable(stepApi, reader, step));
  }
  return { tables: Object.fromEntries(tables) };
}
