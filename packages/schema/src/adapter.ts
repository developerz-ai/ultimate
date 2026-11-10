// `@ultimat3/schema/adapter` — what a schema provider author reads: the built-in provider and the
// active-provider accessor and reset. Never the `.` barrel: an app installs a provider with
// `configureSchemaProvider()`, so the only callers here are a provider author and test teardown.

export { builtinProvider, resetSchemaProvider, schemaProvider } from './provider';
