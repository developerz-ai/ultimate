// `openapi.json`, projected from the two registries: the actions by `@ultimat3/action`'s
// `buildOpenApi`, the queries by `@ultimat3/query`'s `queryOpenApiPaths`. The CLI merges the two
// `paths` maps — those packages are one tier and cannot compose each other — writes the file and
// compares the bytes; it does not know how an operation is shaped, which is why there is no third
// OpenAPI builder to drift from the ones the packages serve. Until 2026-09 only the actions were
// here, and every `GET /_x/query/<name>` the server mounted was a route the spec had never heard of.

import { buildOpenApi, serializeOpenApi } from '@ultimat3/action';
import type { Manifest } from '@ultimat3/manifest';
import { queryOpenApiPaths } from '@ultimat3/query';

export const OPENAPI_FILE = 'openapi.json';

/** The exact bytes on disk — deterministic, so `x verify` can compare them literally. */
export const openApiJson = (manifest: Manifest): string => {
  const document = buildOpenApi({ title: manifest.app.name, version: manifest.app.version });
  // Action paths are `/api/...`, query paths `/_x/query/...`: disjoint by prefix, so the spread
  // can never shadow one with the other. `serializeOpenApi` sorts the merged keys.
  return serializeOpenApi({ ...document, paths: { ...document.paths, ...queryOpenApiPaths() } });
};
