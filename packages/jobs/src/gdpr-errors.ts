// The two `X_PERSONAL_DATA_*` refusals: a subject's erase that would leave a `personalData()` column
// standing, and a marked entity no subject reaches. Both are refusals of DECLARATIONS — the values
// printed are entity and column names, never a person's data.

import { UltimateError } from '@ultimat3/core';
import './error-codes';

/** A reached table's `{ anonymize }` does not name every marked column of it. */
export class PersonalDataUnerasedError extends UltimateError {
  constructor(input: { subject: string; table: string; columns: readonly string[] }) {
    const named = input.columns.map((column) => `${column}: null`).join(', ');
    super({
      code: 'X_PERSONAL_DATA_UNERASED',
      cause: `defineSubject(${input.subject}) anonymizes ${input.table} without ${input.columns.join(', ')}, marked personalData() — an erase would leave the person's value in them`,
      fix: `tables: { ${input.table}: { anonymize: { ${named} } } }   # in defineSubject(${input.subject}, …), merged into the existing anonymize — or 'delete', or { retain: '<why it is kept>' }`,
      meta: { subject: input.subject, table: input.table, columns: [...input.columns] },
    });
  }
}

/** No declared subject's walk reaches an entity carrying marked columns. */
export class PersonalDataUnreachedError extends UltimateError {
  constructor(input: { table: string; columns: readonly string[]; subjects: readonly string[] }) {
    const by =
      input.subjects.length === 0
        ? 'no subject is declared'
        : `declared: ${input.subjects.join(', ')}`;
    super({
      code: 'X_PERSONAL_DATA_UNREACHED',
      cause: `${input.table} marks ${input.columns.join(', ')} personalData() and no defineSubject() walk reaches it (${by}) — no export or erase would ever see them`,
      fix: `defineSubject(${input.table}, { driver, key, tables: { ${input.table}: 'delete' } })   # in the module declaring subjects — or a reference to a subject's entity, or columns: { ${input.table}: '<key column>' } on an existing defineSubject`,
      meta: { table: input.table, columns: [...input.columns], subjects: [...input.subjects] },
    });
  }
}
