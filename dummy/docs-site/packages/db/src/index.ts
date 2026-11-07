// Schema, migrations and the typed handle — no business logic lives in this package.
// `db` is the handle `./client` builds over the app's entities: `db.<table>`, which is what a
// feature's repo.ts reads through. `sql` and `withTransaction` are @ultimat3/db's own, and the
// connection pool behind all three is one, sized by ROLE.
export type { DbClient, SqlFragment } from '@ultimat3/db';
export { sql, withTransaction } from '@ultimat3/db';
export type { Db } from './client';
export { db, driver, selectDriver } from './client';
export * as schema from './schema';
