// `subjectProof(subject)`: the subject erase PROVED on generated data. Seed every table with
// canaries, pick one person, run the erase's table passes as a worker in that person's tenant,
// then search every table's stored rows for that person's canaries and deleted keys. Anything
// left outside a declared `retain` is `X_SUBJECT_ERASE_INCOMPLETE`, naming the table and column.

import type { UltimateError } from '@ultimat3/core';
import { ctxOf, finiteOption, runWithContext, serviceActor } from '@ultimat3/core';
import type { Subject, SubjectPlan } from '@ultimat3/jobs';
import { memoryStepStore, planSubject, stepRunner, subjectEraseTables } from '@ultimat3/jobs';
import { seedGraph } from './seed-graph';
import type { SeedFactory, SeedGraph, SeedWriter } from './seed-graph-plan';
import { insertSeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { SubjectEraseIncompleteError } from './subject-proof-error';

type Stored = Readonly<Record<string, unknown>>;

export interface SubjectProofOptions {
  /** Every entity to seed and search — the same set `seedGraph` takes. */
  readonly entities: readonly SeedEntity[];
  readonly writer: SeedWriter;
  /** Every stored row of one table, as the database holds it, unscoped. */
  readonly read: (entity: SeedEntity) => Promise<readonly Stored[]>;
  readonly seed?: number;
  /** `defineExercise`'s factories: a table only they satisfy is built by them for the proof too. */
  readonly factories?: Readonly<Record<string, SeedFactory>> | undefined;
}

export interface SubjectProofResult {
  readonly subject: string;
  /** The person erased, by key; absent when the plan refused before a row was seeded. */
  readonly key?: string;
  readonly problems: readonly UltimateError[];
}

interface Reached {
  readonly entity: string;
  readonly row: Stored;
  readonly marker: string | undefined;
}

const ownKey = (entity: string, row: Stored, primaryKey: readonly string[]): string =>
  `${entity}|${JSON.stringify(primaryKey.map((property) => row[property]))}`;

/** The seeded rows of the person, table by table, walked as the plan walks them: parents first. */
function reachedRows(
  graph: SeedGraph,
  plan: SubjectPlan,
  entities: ReadonlyMap<string, SeedEntity>,
  subjectRow: Stored,
) {
  const markers = new Map<string, string>();
  graph.inserts.forEach((insert, i) => {
    const entity = entities.get(insert.entity);
    const marker = graph.canaries[i]?.marker;
    if (entity !== undefined && marker !== undefined) {
      markers.set(ownKey(insert.entity, insert.row, entity.$primaryKey), marker);
    }
  });
  const rowsOf = (entity: string) =>
    graph.inserts.filter((i) => i.entity === entity).map((i) => i.row);
  const selected = new Map<string, readonly Stored[]>([[plan.subject, [subjectRow]]]);
  for (const step of [...plan.steps].reverse()) {
    if (step.entity === plan.subject) continue;
    selected.set(
      step.entity,
      rowsOf(step.entity).filter((row) =>
        step.via.some((via) =>
          (selected.get(via.parent) ?? []).some(
            (parent) => parent[via.parentKey] === row[via.property],
          ),
        ),
      ),
    );
  }
  const reached: Reached[] = [];
  for (const [entity, rows] of selected) {
    const core = entities.get(entity);
    for (const row of rows) {
      reached.push({
        entity,
        row,
        marker: core === undefined ? undefined : markers.get(ownKey(entity, row, core.$primaryKey)),
      });
    }
  }
  return reached;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

const physical = (entity: SeedEntity, property: string): string =>
  entity.$describe().columns.find((column) => column.property === property)?.column ?? property;

export async function subjectProof<I>(
  subject: Subject<I>,
  options: SubjectProofOptions,
): Promise<SubjectProofResult> {
  const { registeredEntities } = await import('@ultimat3/entity');
  const { plan, problems } = planSubject({
    subject: subject.entity,
    tables: subject.init.tables,
    columns: subject.init.columns,
    entries: registeredEntities(),
  });
  if (problems.length > 0) return { subject: subject.entity, problems };
  const entities = new Map(options.entities.map((entity) => [entity.$name, entity]));
  const graph = seedGraph(Object.fromEntries(entities), {
    seed: finiteOption('subjectProof', 'seed', options.seed ?? 1),
    tenants: 2,
    ...(options.factories === undefined ? {} : { factories: options.factories }),
  });
  await insertSeedGraph(graph, options.writer);
  const tenant = graph.tenants[0] ?? null;
  const person = graph.inserts.find(
    (i) => i.entity === subject.entity && (i.tenant === tenant || i.tenant === null),
  );
  const root = entities.get(subject.entity);
  if (person === undefined || root === undefined) return { subject: subject.entity, problems: [] };
  const key = String(person.row[plan.key]);
  const reached = reachedRows(graph, plan, entities, person.row);

  const treatments = new Map(Object.entries(subject.init.tables));
  const kept = (entity: string) => {
    const treatment = treatments.get(entity);
    return typeof treatment === 'object' && treatment !== null && 'retain' in treatment;
  };
  const step = stepRunner({
    runId: `subject-proof:${key}`,
    jobName: 'subject-proof',
    store: memoryStepStore(),
  }).step;
  const actor = serviceActor({
    id: 'subject-proof',
    ...(tenant === null ? {} : { orgId: tenant }),
  });
  await runWithContext(ctxOf({ role: 'worker', actor }), () =>
    subjectEraseTables(subject, key, step),
  );

  const markers = new Set(
    reached.flatMap((r) => (kept(r.entity) || r.marker === undefined ? [] : [r.marker])),
  );
  const gone = reached.filter((r) => treatments.get(r.entity) === 'delete');
  const found: UltimateError[] = [];
  for (const entity of options.entities) {
    if (kept(entity.$name) || entity.$describe().view !== undefined) continue;
    const rows = await options.read(entity);
    const keyColumns = entity.$primaryKey.map((property) => physical(entity, property));
    const deleted = new Set(
      gone
        .filter((r) => r.entity === entity.$name)
        .map((r) => JSON.stringify(entity.$primaryKey.map((p) => String(r.row[p])))),
    );
    for (const row of rows) {
      if (deleted.has(JSON.stringify(keyColumns.map((column) => String(row[column]))))) {
        found.push(
          new SubjectEraseIncompleteError({
            subject: subject.entity,
            table: entity.$name,
            column: keyColumns.join(', '),
            what: 'a row the erase deletes is still stored',
          }),
        );
      }
      for (const [column, value] of Object.entries(row)) {
        const text = asText(value);
        if ([...markers].some((marker) => text.includes(marker))) {
          found.push(
            new SubjectEraseIncompleteError({
              subject: subject.entity,
              table: entity.$name,
              column,
              what: 'still holds a seeded value of the subject',
            }),
          );
        }
      }
    }
  }
  return { subject: subject.entity, key, problems: found };
}
