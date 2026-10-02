// `@ultimat3/db/schema-dump`: the whole schema as files, and the drift checks over them. Its own
// entry because only three callers ever run it — `x db gen`, `x db migrate` and the gate's `drift`
// step — while `@ultimat3/db` is imported by every role of every app: on the barrel these ten
// modules were evaluated by every web, worker and scheduler pod to serve nothing.

export type {
  CatalogColumn,
  CatalogConstraint,
  CatalogDescription,
  CatalogDomain,
  CatalogEnum,
  CatalogExtension,
  CatalogForeignKey,
  CatalogFunction,
  CatalogIndex,
  CatalogOwnedSequence,
  CatalogReplicaIdentity,
  CatalogSequence,
  CatalogTable,
  CatalogTrigger,
  CatalogType,
  CatalogUnrendered,
  CatalogView,
} from './catalog';
export { emptyCatalog } from './catalog';
export type { SchemaDumpDifference, SchemaDumpDifferenceKind } from './dump-drift';
export {
  compareSchemaDump,
  reloadDifferences,
  schemaDumpDifferenceOf,
  schemaDumpDrift,
} from './dump-drift';
export type { IntrospectCatalogOptions } from './introspect-catalog';
export { introspectCatalog } from './introspect-catalog';
export { unexpectedObjects } from './object-drift';
export type { SchemaDumpFile } from './schema-dump';
export { renderSchemaDump } from './schema-dump';
export type { LoadSchemaDumpOptions, SchemaLoadReport } from './schema-load';
export { loadSchemaDump } from './schema-load';
