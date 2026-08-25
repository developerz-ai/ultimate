// The one code raised while installing the framework's own tables. Apart from `errors.ts` for the
// reason `packages/jobs/src/backfill-errors.ts` is apart from that package's: one file, one job,
// and `errors.ts` is at 486 lines against the 500 the `filesize` step enforces. The code, its
// title and its registration stay in `error-codes.ts`, where every other CLI code lives.

import { renderThrowable, UltimateError } from '@ultimat3/core';

/**
 * A statement in `FRAMEWORK_SCHEMA` did not apply. Raised in place of the driver's own rejection,
 * which names neither the framework table being created nor the package that wants it — and a boot
 * failure is read by an operator with no source tree open.
 *
 * `renderThrowable` and never `${cause}`: a `catch` binding is annotated by nobody, and a pool
 * rejection is routinely an object whose `toString` throws.
 */
export class FrameworkSchemaFailedError extends UltimateError {
  constructor(input: { pkg: string; tables: readonly string[]; cause: unknown }) {
    super({
      code: 'X_FRAMEWORK_SCHEMA_FAILED',
      cause: `${input.pkg} could not create ${input.tables.join(', ')}: ${renderThrowable(input.cause)}`,
      // An EDIT plus the command that CONFIRMS it, which is the house shape for a repair the gate
      // cannot perform: the two real causes are a role without `create`, and a relation of that
      // name already present with an incompatible shape.
      fix: `grant create on schema public to the role in DATABASE_URL, then re-run: x db migrate`,
      meta: { pkg: input.pkg, tables: [...input.tables] },
    });
  }
}
