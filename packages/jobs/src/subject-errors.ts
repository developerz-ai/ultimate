// The three `X_SUBJECT_*` refusals a subject's plan can end on — each a refusal of the
// DECLARATION, so a run raises the first and `x exercise` lists every one. The codes, titles and
// retry classes are `error-codes.ts`'s; the values printed are entity and column names, never data.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';

/** A table reaches the subject and `tables:` gives it no treatment. `path` is how it reaches. */
export class SubjectTableUndeclaredError extends UltimateError {
  constructor(input: { subject: string; table: string; path: readonly string[] }) {
    super({
      code: 'X_SUBJECT_TABLE_UNDECLARED',
      cause: `${input.table} reaches the subject ${input.subject} (${input.path.join(' <- ')}) and defineSubject(${input.subject}) gives it no treatment, so an erase would leave its rows and an export would miss them`,
      fix: `tables: { ${input.table}: 'delete' }   # in defineSubject(${input.subject}, …) — or { anonymize: { <column>: <value> } }, or { retain: '<why it is kept>' }`,
      meta: { subject: input.subject, table: input.table, path: [...input.path] },
    });
  }
}

/** A treatment that cannot be carried out. `field` names what to change. */
export class SubjectTreatmentInvalidError extends UltimateError {
  constructor(input: {
    subject: string;
    table: string;
    field: string;
    reason: string;
    /** The treatment the repair is: `'delete'` for a kept row a delete would block. */
    instead?: string;
  }) {
    super({
      code: 'X_SUBJECT_TREATMENT_INVALID',
      cause: `defineSubject(${input.subject}) treats ${input.table}: ${input.field} ${input.reason}`,
      fix: `tables: { ${input.table}: ${input.instead ?? "{ retain: '<why it is kept>' }"} }   # in defineSubject(${input.subject}, …), or correct ${input.field} as the cause says`,
      meta: { subject: input.subject, table: input.table, field: input.field },
    });
  }
}

/** Tables the erase deletes reference each other through keys that are all `not null`. */
export class SubjectCycleError extends UltimateError {
  constructor(input: { subject: string; table: string; column: string; parent: string }) {
    super({
      code: 'X_SUBJECT_CYCLE',
      cause: `${input.table}.${input.column} references ${input.parent}, which the erase of ${input.subject} also deletes, and closes a loop — the key is not nullable, so neither side can go first`,
      fix: `x db gen ${renderFixShellArg(`nullable ${input.table} ${input.column}`, '<description>')}   # after ${input.column}: uuid().nullable() in entity('${input.table}'): the erase clears it before deleting either side`,
      meta: { subject: input.subject, table: input.table, column: input.column },
    });
  }
}
