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
      // The migrate step, as the role that owns the schema. The common cause is `42501`: a runtime
      // role with DML only — no `create` on `public`, and not the owner of an existing framework
      // table, which Postgres demands even of `create index if not exists`. Granting that role
      // `create` (this line's old advice) cures the first and never the second, and widens the
      // runtime role besides. The rarer cause, a relation of that name with another shape, is
      // named in `cause` and reported again by the same command.
      fix: 'x db migrate   # with DATABASE_URL naming the role that owns schema public, as ROLE=migrate runs',
      meta: { pkg: input.pkg, tables: [...input.tables] },
    });
  }
}
