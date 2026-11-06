// How one run finds the subject's rows: through the app's own repositories (a `database()` over
// the app's driver, so tenancy, the row observer and cache tags hold), a page at a time. A table's
// rows are those whose key is in a page of its parent's rows — never a statement unbounded by a page.

import { assert } from '@ultimat3/core';
import type { EntityCore, Table } from '@ultimat3/entity';
import { database, getEntity } from '@ultimat3/entity';
import type { Subject } from './subject';
import type { SubjectPlan, SubjectVia } from './subject-plan';

export type SubjectRow = Readonly<Record<string, unknown>>;
export type SubjectTable = Table<Record<string, unknown>>;

export interface SubjectReader {
  readonly plan: SubjectPlan;
  readonly key: string;
  readonly size: number;
  table(entity: string): SubjectTable;
  core(entity: string): EntityCore;
  /** The subject's row, read now — never checkpointed, since it is the person's data. */
  rootRow(): Promise<SubjectRow | null>;
  /** Every row of `entity` the plan reaches, a page at a time. A row two paths reach comes twice. */
  pages(entity: string): AsyncGenerator<readonly SubjectRow[]>;
  /** The values `via` matches on, a page of the parent's rows at a time. */
  parentKeys(via: SubjectVia): AsyncGenerator<readonly unknown[]>;
}

/** The primary key of one row as one string: what tells two pages' copies of a row apart. */
export const rowIdentity = (core: EntityCore, row: SubjectRow): string =>
  JSON.stringify(core.$primaryKey.map((property) => String(row[property])));

export function subjectReader<I>(
  subject: Subject<I>,
  plan: SubjectPlan,
  key: string,
): SubjectReader {
  const cores = new Map<string, EntityCore>();
  for (const name of [plan.subject, ...plan.steps.map((step) => step.entity)]) {
    const core = getEntity(name)?.core;
    assert(
      core !== undefined,
      `the subject ${plan.subject} reaches ${name}, which registered no entity core`,
      `x exercise --json   # lists the subject's reach; declare ${name} with entity() before the subject runs`,
    );
    cores.set(name, core as EntityCore);
  }
  const db = database(Object.fromEntries(cores), { driver: subject.init.driver });
  const tables = new Map<string, SubjectTable>(
    Object.entries(db).map(([name, table]) => [name, table as unknown as SubjectTable]),
  );
  const steps = new Map(plan.steps.map((step) => [step.entity, step]));
  const size = subject.batch;

  const table = (entity: string): SubjectTable => {
    const found = tables.get(entity);
    assert(
      found !== undefined,
      `the subject ${plan.subject} asked for ${entity}, which its plan does not reach`,
      `x exercise --json   # prints the subject's plan`,
    );
    return found;
  };
  const rootRow = (): Promise<SubjectRow | null> =>
    table(plan.subject)
      .where({ [plan.key]: key })
      .one();

  async function* parentKeys(via: SubjectVia): AsyncGenerator<readonly unknown[]> {
    if (via.parent === plan.subject) {
      const row = await rootRow();
      const value = row?.[via.parentKey];
      if (value !== undefined && value !== null) yield [value];
      return;
    }
    for await (const page of pages(via.parent)) {
      const values = new Set(page.map((row) => row[via.parentKey]));
      values.delete(null);
      values.delete(undefined);
      if (values.size > 0) yield [...values];
    }
  }

  async function* pages(entity: string): AsyncGenerator<readonly SubjectRow[]> {
    if (entity === plan.subject) {
      const row = await rootRow();
      if (row !== null) yield [row];
      return;
    }
    for (const via of steps.get(entity)?.via ?? []) {
      for await (const values of parentKeys(via)) {
        yield* table(entity).andWhere(via.property, 'in', values).inBatches(size);
      }
    }
  }

  return {
    plan,
    key,
    size,
    table,
    core: (entity) => cores.get(entity) as EntityCore,
    rootRow,
    pages,
    parentKeys,
  };
}
