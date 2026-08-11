// Schema and migrations only — no business logic lives in this package. The client itself is
// @ultimat3/db's: one connection pool, sized by ROLE, shared by every package in the app.
export type { DbClient, SqlFragment } from '@ultimat3/db';
export { db, sql, withTransaction } from '@ultimat3/db';
export * as schema from './schema';
