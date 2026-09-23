// `openapi.json`, projected from the two registries: the actions by `@ultimat3/action`'s
// `buildOpenApi`, the queries by `@ultimat3/query`'s `queryOpenApiPaths`. The CLI merges the two
// `paths` maps — those packages are one tier and cannot compose each other — writes the file and
// compares the bytes; it does not know how an operation is shaped, which is why there is no third
// OpenAPI builder to drift from the ones the packages serve. Until 2026-09 only the actions were
// here, and every `GET /_x/query/<name>` the server mounted was a route the spec had never heard of.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { buildOpenApi, serializeOpenApi } from '@ultimat3/action';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Manifest } from '@ultimat3/manifest';
import { queryOpenApiPaths } from '@ultimat3/query';
import type { Finding } from './output';

export const OPENAPI_FILE = 'openapi.json';

/** The exact bytes on disk — deterministic, so `x verify` can compare them literally. */
export const openApiJson = (manifest: Manifest): string => {
  const document = buildOpenApi({ title: manifest.app.name, version: manifest.app.version });
  // Action paths are `/api/...`, query paths `/_x/query/...`: disjoint by prefix, so the spread
  // can never shadow one with the other. `serializeOpenApi` sorts the merged keys.
  return serializeOpenApi({ ...document, paths: { ...document.paths, ...queryOpenApiPaths() } });
};

/**
 * The typed client is generated from `openapi.json`, so a stale spec ships a wrong client. One
 * check, read by `x verify`'s `manifest` step AND `x manifest --check` — which looked at
 * `x.manifest.json` alone and answered "fresh" over a spec the gate refused.
 */
export async function openApiStaleness(
  root: string,
  manifest: Manifest,
): Promise<readonly Finding[]> {
  const path = join(root, OPENAPI_FILE);
  if (!(await Bun.file(path).exists())) return [];
  if ((await Bun.file(path).text()) === openApiJson(manifest)) return [];
  return [
    {
      code: 'X_MANIFEST_STALE',
      cause: `${OPENAPI_FILE} does not match the actions the code registers`,
      fix: 'x manifest',
      docs: ERROR_DOCS_URL,
      at: OPENAPI_FILE,
    },
  ];
}
