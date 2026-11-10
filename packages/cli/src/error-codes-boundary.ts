// The X_* codes of the `boundaries` step's import rules — the app's surfaces, its layers, its
// packages, the adapter and loader subpaths — split out of `error-codes.ts` at its 500-line
// ceiling, as `error-codes-shot.ts` was. `@ultimat3/render` owns the surface *rule*; the CLI owns the diagnostic
// (`app-boundaries.ts` holds the one rule-to-code table). That file registers these in its one call.

/** Codes the `boundaries` step and `x fix boundary` report. */
export const CLI_BOUNDARY_ERROR_CODES = [
  'X_BOUNDARY_SITE_TO_APP',
  'X_BOUNDARY_SHARED_LEAF',
  'X_BOUNDARY_APP_TO_API',
  'X_BOUNDARY_ROUTE_TO_DB',
  'X_BOUNDARY_SERVICE_TO_HTTP',
  'X_BOUNDARY_SURFACE_IMPORT',
  'X_BOUNDARY_PACKAGE_TO_APP',
  'X_BOUNDARY_ADAPTER_IMPORT',
  'X_BOUNDARY_LOADER_IMPORT',
] as const;

export type CliBoundaryErrorCode = (typeof CLI_BOUNDARY_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_BOUNDARY_ERROR_TITLES: Readonly<Record<CliBoundaryErrorCode, string>> = {
  X_BOUNDARY_SITE_TO_APP: 'site/ imported app/',
  X_BOUNDARY_SHARED_LEAF: 'shared/ imported a surface',
  X_BOUNDARY_APP_TO_API: 'app/ imported api/ at runtime',
  X_BOUNDARY_ROUTE_TO_DB: 'a route touched the database',
  X_BOUNDARY_SERVICE_TO_HTTP: 'a service imported HTTP',
  X_BOUNDARY_SURFACE_IMPORT: 'a surface imports one SURFACE_SPECS does not allow',
  X_BOUNDARY_PACKAGE_TO_APP: 'packages/ imported apps/ at runtime',
  X_BOUNDARY_ADAPTER_IMPORT: 'an app module imports an adapter installer',
  X_BOUNDARY_LOADER_IMPORT: 'an app module imports a registration loader',
};
