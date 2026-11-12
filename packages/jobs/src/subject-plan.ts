// The subject's plan, pure: which tables reach the subject (a foreign-key walk from it, continued
// only through tables the erase deletes), how each one's rows are found, the order that deletes
// children before parents, and every refusal of the declaration. Registry entries in, plan out.

import type { UltimateError } from '@ultimat3/core';
import type { ColumnDescription, EntityDescription, RegistryEntry } from '@ultimat3/entity';
import type { SubjectTreatment } from './subject';
import {
  SubjectCycleError,
  SubjectTableUndeclaredError,
  SubjectTreatmentInvalidError,
} from './subject-errors';
import { historyReach } from './subject-plan-history';

/** How one table's rows of the subject are found: `<table>.<property>` equal to `<parent>.<key>`. */
export interface SubjectVia {
  readonly property: string;
  readonly parent: string;
  readonly parentKey: string;
}

export interface SubjectStep {
  readonly entity: string;
  readonly treatment: SubjectTreatment;
  /** Empty for the subject itself, which is found by its key. */
  readonly via: readonly SubjectVia[];
  /**
   * This table's `<table>_history`, declared `'delete'`: its rows of each row this step writes go
   * in the same transaction, after the write — whose own trigger has just recorded one more image.
   */
  readonly history?: string;
}

/** A key closing a loop: set to null on the rows naming a parent the erase deletes, before any. */
export interface SubjectUnlink extends SubjectVia {
  readonly entity: string;
}

export interface SubjectPlan {
  readonly subject: string;
  /** The subject's single primary-key property. */
  readonly key: string;
  readonly unlink: readonly SubjectUnlink[];
  /** Children first, the subject last: the order an erase runs in. */
  readonly steps: readonly SubjectStep[];
}

export interface SubjectPlanInput {
  readonly subject: string;
  readonly tables: Readonly<Record<string, SubjectTreatment>>;
  readonly columns?: Readonly<Record<string, string>> | undefined;
  readonly entries: readonly RegistryEntry[];
}

interface Edge extends SubjectVia {
  readonly from: string;
  readonly nullable: boolean;
  readonly onDelete: string | null;
}

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

const isDelete = (treatment: SubjectTreatment | undefined): boolean => treatment === 'delete';

const nulls = (treatment: SubjectTreatment | undefined, property: string): boolean =>
  typeof treatment === 'object' &&
  'anonymize' in treatment &&
  Object.hasOwn(treatment.anonymize, property) &&
  treatment.anonymize[property] === null;

/** The column a property names, or undefined. */
const columnOf = (d: EntityDescription, property: string): ColumnDescription | undefined =>
  d.columns.find((column) => column.property === property);

/** Every key INTO each entity — declared references, then the hand-listed `columns:`. */
function inboundEdges(input: SubjectPlanInput, byName: ReadonlyMap<string, RegistryEntry>) {
  const inbound = new Map<string, Edge[]>();
  const push = (to: string, edge: Edge): void => {
    inbound.set(to, [...(inbound.get(to) ?? []), edge]);
  };
  for (const entry of byName.values()) {
    for (const ref of entry.references()) {
      push(ref.targetEntity, {
        from: entry.name,
        property: ref.property,
        parent: ref.targetEntity,
        parentKey: ref.targetProperty,
        nullable: ref.nullable,
        onDelete: ref.onDelete,
      });
    }
  }
  const root = byName.get(input.subject)?.describe();
  const rootKey = root?.columns.find((column) => column.primaryKey)?.property ?? 'id';
  for (const [entity, property] of Object.entries(input.columns ?? {})) {
    const column = byName
      .get(entity)
      ?.describe()
      .columns.find((c) => c.property === property);
    push(input.subject, {
      from: entity,
      property,
      parent: input.subject,
      parentKey: rootKey,
      nullable: column?.notNull === false,
      onDelete: null,
    });
  }
  for (const edges of inbound.values()) {
    edges.sort((a, b) => `${a.from}.${a.property}`.localeCompare(`${b.from}.${b.property}`));
  }
  return inbound;
}

const isAnonymize = (treatment: SubjectTreatment): boolean =>
  typeof treatment === 'object' && treatment !== null && 'anonymize' in treatment;

/** What is wrong with one declared treatment on its own, before any reach is considered. */
function treatmentProblems(
  subject: string,
  table: string,
  treatment: SubjectTreatment,
  entry: RegistryEntry | undefined,
): readonly UltimateError[] {
  const invalid = (field: string, reason: string) =>
    new SubjectTreatmentInvalidError({ subject, table, field, reason });
  if (entry === undefined) return [invalid(table, 'names no registered entity')];
  const d = entry.describe();
  // Nothing the app writes reaches a readOnly table: only `retain` can be true of one.
  if (d.readOnly !== undefined && (treatment === 'delete' || isAnonymize(treatment))) {
    const field = treatment === 'delete' ? "'delete'" : 'anonymize';
    return [invalid(field, `is refused: the entity is readOnly (${d.readOnly})`)];
  }
  if (d.historyOf !== undefined && isAnonymize(treatment)) {
    return [
      invalid(
        'anonymize',
        `is refused: ${table} is the history of ${d.historyOf}, and history is never rewritten — 'delete' it, or { retain: '<why it is kept>' }`,
      ),
    ];
  }
  if (treatment === 'delete') {
    if (d.appendOnly === true) {
      return [invalid("'delete'", 'is refused: the entity is append-only')];
    }
    if (d.softDelete) {
      return [invalid("'delete'", 'only stamps deleted_at: a soft delete keeps every value')];
    }
    return [];
  }
  if (typeof treatment !== 'object' || treatment === null) {
    return [invalid('the treatment', "is none of 'delete', { anonymize } or { retain }")];
  }
  if ('retain' in treatment) {
    const reason = treatment.retain;
    return typeof reason === 'string' && reason.trim().length > 0
      ? []
      : [invalid('retain', 'is blank: the reason is printed in every export and is required')];
  }
  if (!('anonymize' in treatment)) {
    return [invalid('the treatment', "is none of 'delete', { anonymize } or { retain }")];
  }
  if (d.appendOnly === true) return [invalid('anonymize', 'is refused: the entity is append-only')];
  const named = Object.entries(treatment.anonymize);
  if (named.length === 0) return [invalid('anonymize', 'names no column')];
  return named.flatMap(([property, value]) => {
    const column = columnOf(d, property);
    if (column === undefined) return [invalid(`anonymize.${property}`, 'is not a column')];
    if (column.primaryKey) return [invalid(`anonymize.${property}`, 'is the primary key')];
    if (value === null && column.notNull) {
      return [invalid(`anonymize.${property}`, 'is null and the column is not nullable')];
    }
    return [];
  });
}

/** A kept row under a parent the erase deletes: it would block the delete, or be cascaded away. */
function keptUnderDeleted(
  subject: string,
  edge: Edge,
  treatment: SubjectTreatment,
): UltimateError | undefined {
  if (isDelete(treatment) || nulls(treatment, edge.property)) return undefined;
  if (edge.nullable && (edge.onDelete === 'set null' || edge.onDelete === 'set default')) {
    return undefined;
  }
  return new SubjectTreatmentInvalidError({
    subject,
    table: edge.from,
    field: edge.property,
    instead: "'delete'",
    reason:
      edge.onDelete === 'cascade'
        ? `keeps rows the delete of ${edge.parent} cascades away — use 'delete', or anonymize ${edge.property}: null on a nullable key`
        : `keeps rows that block the delete of ${edge.parent} — use 'delete', or anonymize ${edge.property}: null on a nullable key`,
  });
}

export function planSubject(input: SubjectPlanInput): {
  readonly plan: SubjectPlan;
  readonly problems: readonly UltimateError[];
} {
  const byName = new Map(
    input.entries
      .filter((entry) => entry.describe().view === undefined)
      .map((entry) => [entry.name, entry]),
  );
  const subject = input.subject;
  const problems: UltimateError[] = [];
  const root = byName.get(subject)?.describe();
  const keys = root?.columns.filter((column) => column.primaryKey) ?? [];
  const key = keys[0]?.property ?? 'id';
  if (root === undefined || keys.length !== 1) {
    problems.push(
      new SubjectTreatmentInvalidError({
        subject,
        table: subject,
        field: 'the subject',
        reason:
          root === undefined
            ? 'names no registered entity'
            : 'has a composite primary key: a subject is found by one key',
      }),
    );
  }
  for (const [table, treatment] of Object.entries(input.tables)) {
    problems.push(...treatmentProblems(subject, table, treatment, byName.get(table)));
  }
  const inbound = inboundEdges(input, byName);
  const treatmentOf = (entity: string) => own(input.tables, entity);
  const propagates = (entity: string) => entity === subject || isDelete(treatmentOf(entity));

  const state = new Map<string, 'open' | 'done'>();
  const via = new Map<string, SubjectVia[]>();
  const order: string[] = [];
  const unlink: SubjectUnlink[] = [];
  const undeclared = new Set<string>();
  if (treatmentOf(subject) === undefined && root !== undefined) {
    problems.push(new SubjectTableUndeclaredError({ subject, table: subject, path: [subject] }));
    undeclared.add(subject);
  }

  const walk = (entity: string, path: readonly string[]): void => {
    state.set(entity, 'open');
    const deleted = isDelete(treatmentOf(entity));
    for (const edge of inbound.get(entity) ?? []) {
      const here = [...path, `${edge.from}.${edge.property}`];
      const treatment = treatmentOf(edge.from);
      if (treatment === undefined) {
        if (!undeclared.has(edge.from)) {
          undeclared.add(edge.from);
          problems.push(new SubjectTableUndeclaredError({ subject, table: edge.from, path: here }));
        }
        continue;
      }
      if (state.get(edge.from) === 'open') {
        // A back edge closes a loop: it finds no rows, and a deleted parent needs it cleared first.
        if (!deleted) continue;
        if (edge.nullable) unlink.push({ entity: edge.from, ...edgeVia(edge) });
        else problems.push(new SubjectCycleError({ subject, table: edge.from, ...cycleOf(edge) }));
        continue;
      }
      if (deleted) {
        const kept = keptUnderDeleted(subject, edge, treatment);
        if (kept !== undefined) problems.push(kept);
      }
      via.set(edge.from, [...(via.get(edge.from) ?? []), edgeVia(edge)]);
      if (state.has(edge.from)) continue;
      if (propagates(edge.from)) walk(edge.from, here);
      else {
        state.set(edge.from, 'done');
        order.push(edge.from);
      }
    }
    state.set(entity, 'done');
    order.push(entity);
  };
  if (root !== undefined) walk(subject, [subject]);

  const history = historyReach({ subject, byName, reached: (e) => state.has(e), treatmentOf });
  problems.push(...history.problems);
  for (const [table, kept] of history.retained) {
    // Counted before the parent's step writes: a deleted parent's rows find nothing after it.
    state.set(table, 'done');
    via.set(table, [kept.via]);
    order.splice(order.indexOf(kept.parent), 0, table);
  }
  for (const table of history.reached) if (!state.has(table)) state.set(table, 'done');

  for (const table of Object.keys(input.tables)) {
    if (byName.has(table) && !state.has(table)) {
      problems.push(
        new SubjectTreatmentInvalidError({
          subject,
          table,
          field: table,
          reason: `is declared and nothing reaches it from ${subject} — remove it, or list its key column in columns:`,
        }),
      );
    }
  }
  const steps = order
    .filter((entity) => treatmentOf(entity) !== undefined)
    .map((entity) => {
      const kept = history.deletedWith.get(entity);
      return {
        entity,
        treatment: treatmentOf(entity) as SubjectTreatment,
        via: via.get(entity) ?? [],
        ...(kept === undefined ? {} : { history: kept }),
      };
    });
  return { plan: { subject, key, unlink, steps }, problems };
}

const edgeVia = (edge: Edge): SubjectVia => ({
  property: edge.property,
  parent: edge.parent,
  parentKey: edge.parentKey,
});

const cycleOf = (edge: Edge) => ({ column: edge.property, parent: edge.parent });
