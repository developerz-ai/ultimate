// The manifest's `subjects` section: each `defineSubject()` as a fact — whose data it is, and what
// an erase does to every table holding some of it. Types only; `schema.ts` composes it, so a
// treatment moving from kept to deleted is a change `x manifest diff` can call breaking.

/** The treatment's kind. Its arguments (the anonymized values) stay in code, never in the file. */
export type SubjectTreatmentFact = 'delete' | 'anonymize' | 'retain';

export interface SubjectTableFact {
  /** The entity's name, as `entities` lists it. */
  readonly entity: string;
  readonly treatment: SubjectTreatmentFact;
  /** `anonymize` only: the columns overwritten, sorted. */
  readonly columns?: readonly string[];
  /** `retain` only: the reason the export prints. */
  readonly reason?: string;
}

export interface SubjectTargetFact {
  /** A framework-held store (`x_users`, stored files): exported, and erased unless retained. */
  readonly name: string;
  readonly retained: boolean;
}

export interface SubjectFact {
  /** The subject entity — one subject per entity. */
  readonly entity: string;
  readonly batch: number;
  /** Every reached table, sorted by entity. */
  readonly tables: readonly SubjectTableFact[];
  /** Sorted by name; `[]` when none is declared. */
  readonly targets: readonly SubjectTargetFact[];
  /** Columns holding the subject's key with no foreign key, sorted; absent when none is listed. */
  readonly links?: readonly { readonly entity: string; readonly column: string }[];
}
