// `X_SUBJECT_ERASE_INCOMPLETE`: the subject proof found the person's seeded value after the erase.
// Apart from ./errors, which owns the code, its title and the one registration, because that
// catalogue is at its ceiling. Names the table and the column, never the value.

import { renderFixLiteral, UltimateError } from '@ultimat3/core';
import './errors';

export class SubjectEraseIncompleteError extends UltimateError {
  constructor(input: {
    readonly subject: string;
    readonly table: string;
    readonly column: string;
    readonly what: string;
  }) {
    const table = renderFixLiteral(input.table, '<table>');
    super({
      code: 'X_SUBJECT_ERASE_INCOMPLETE',
      cause: `after subjectErase of one ${input.subject}, ${input.table}.${input.column} ${input.what}: the table is untreated, an anonymize left this column, or it holds a copy of the value with no key to the subject`,
      fix: `x exercise --json   # after tables: { ${table}: 'delete' } (or anonymize: { ${input.column}: <value> }) in defineSubject(${input.subject}, …) — or columns: { ${table}: '<column holding the key>' } for a copy with no foreign key`,
      meta: { subject: input.subject, table: input.table, column: input.column },
    });
  }
}
