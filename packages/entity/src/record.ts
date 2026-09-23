// `@ultimat3/entity/record` — the entity's client projection, and nothing that reaches a driver.
// The package barrel re-exports the same bindings for server code; a BROWSER module imports them
// from here, because the barrel retains ~1 MB of SQL rendering (`pg-sql.ts`, `@ultimat3/db`) a page
// never runs — measured in `record-bundle.test.ts`, which fails if this entry ever grows it back.

export type { ProjectedEntity, RecordProjection } from './record-projection';
export { ENTITY_BRAND, recordProjection } from './record-projection';
export { recordProjectionForTable, recordTypeForTable } from './record-table';
export type { RecordsByKey, RecordsByType } from './rows-of';
export { hasEntityRows, rowsOf } from './rows-of';
