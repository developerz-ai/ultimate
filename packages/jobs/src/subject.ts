// `defineSubject()`: one person's data, declared once — which entity they are, how to find their
// row, and what happens to every table holding something of theirs. A plain value both factories
// take (`subjectExport`, `subjectErase`); the reach itself is derived from foreign keys
// (`subject-plan.ts`), so a table added next month is a build error until it has a treatment.

import { assert } from '@ultimat3/core';
import type { Driver, EntityCore } from '@ultimat3/entity';
import type { ExportValue } from './export-format';

/**
 * What happens to one table's rows of the subject. Nothing defaults (axiom 8): which law applies,
 * what is kept and for how long are the app's, so every reached table states one of the three.
 */
export type SubjectTreatment =
  | 'delete'
  /** Overwrite these columns, keep the row. A key set to `null` unlinks it from the subject. */
  | { readonly anonymize: Readonly<Record<string, unknown>> }
  /** Keep the row as it is. The reason is required and printed in the export's index. */
  | { readonly retain: string };

/** The subject as one run sees it: the key it was asked for and its row, read fresh per step. */
export interface SubjectRef {
  readonly key: string;
  readonly row: Readonly<Record<string, unknown>>;
}

/** One page a target answers for an export: rows over `columns`, and where the next page starts. */
export interface SubjectTargetPage {
  readonly rows: readonly Readonly<Record<string, ExportValue>>[];
  readonly cursor: string | null;
}

/**
 * Data the framework holds outside an app's entities — `x_users`, `x_audit`, stored files —
 * behind the narrowest seam, structural exactly as `PurgeTarget` is: `@ultimat3/auth`,
 * `@ultimat3/action` and `@ultimat3/storage` each satisfy it without this package importing them.
 */
export interface SubjectTarget {
  /** The step key, the export's object prefix and the report's row. Unique within one subject. */
  readonly name: string;
  /** The keys of every row `exportPage` answers, in order: the csv header, the ndjson key order. */
  readonly columns: readonly string[];
  exportPage(subject: SubjectRef, cursor: string | null, size: number): Promise<SubjectTargetPage>;
  /** Remove up to `size` of the subject's records and answer how many went; called until short. */
  erase(subject: SubjectRef, size: number): Promise<number>;
}

/** A target the erase leaves alone: still exported, never erased, the reason printed. */
export interface RetainedTarget {
  readonly target: SubjectTarget;
  readonly retain: string;
}

export type SubjectTargetEntry = SubjectTarget | RetainedTarget;

export interface SubjectInit<I> {
  /** The driver the app's own `database()` reads through, so tenancy and row observers hold. */
  readonly driver: Driver;
  /** The subject's primary key, from the job's input. */
  readonly key: (input: I) => string;
  /** By entity name: every table the subject reaches, the subject's own included. */
  readonly tables: Readonly<Record<string, SubjectTreatment>>;
  readonly targets?: readonly SubjectTargetEntry[];
  /**
   * By entity name: a column holding the subject's key with no foreign key to say so. A table the
   * reference walk cannot see is invisible until it is listed here, and then it needs a treatment.
   */
  readonly columns?: Readonly<Record<string, string>>;
  /** Rows per statement and per step. Default `DEFAULT_SUBJECT_BATCH`. */
  readonly batch?: number;
}

export interface Subject<I> {
  /** The subject entity's name. */
  readonly entity: string;
  readonly init: SubjectInit<I>;
  readonly batch: number;
}

/** One statement's worth of one person's rows: small, since a run is one person, never a table. */
export const DEFAULT_SUBJECT_BATCH = 200;

const declared: Subject<never>[] = [];

export const isRetainedTarget = (entry: SubjectTargetEntry): entry is RetainedTarget =>
  'retain' in entry && 'target' in entry;

export const targetOf = (entry: SubjectTargetEntry): SubjectTarget =>
  isRetainedTarget(entry) ? entry.target : entry;

/**
 * Declare the subject. Checked here only for what needs no other entity — the reach is checked
 * when a run plans it and by `x exercise`, once every entity module has loaded.
 */
export function defineSubject<I>(entity: EntityCore, init: SubjectInit<I>): Subject<I> {
  const batch = init.batch ?? DEFAULT_SUBJECT_BATCH;
  assert(
    Number.isSafeInteger(batch) && batch >= 1,
    `defineSubject(${entity.$name}) declares batch: ${String(batch)}`,
    `batch: ${DEFAULT_SUBJECT_BATCH}   # in defineSubject(${entity.$name}, …): rows per statement, at least one`,
  );
  const names = (init.targets ?? []).map((entry) => targetOf(entry).name);
  assert(
    new Set(names).size === names.length,
    `defineSubject(${entity.$name}) lists targets with one name twice: ${names.join(', ')}`,
    `targets: [ … ]   # in defineSubject(${entity.$name}, …): one entry per target name — the name is the step key`,
  );
  const subject: Subject<I> = { entity: entity.$name, init, batch };
  declared.push(subject as Subject<never>);
  return subject;
}

/** Every subject declared in this process, in declaration order. Read by `x exercise`. */
export const registeredSubjects = (): readonly Subject<never>[] => [...declared];

/** Test-only: forget every declared subject. */
export function resetSubjects(): void {
  declared.length = 0;
}
