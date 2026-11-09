// Every entity the app declares, re-exported here so the seed and anything else that needs a table
// reach them through one import. It is not what the migration generator reads: `x db gen` and the
// `drift` step project the entity registry, so an entity is in the migration because it was
// declared, never because it was listed here.
// `x g entity <name>` writes the entity; add its export here to reach it through `@docs-site/db`.
export {};
