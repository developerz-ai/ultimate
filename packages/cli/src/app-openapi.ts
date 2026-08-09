// `openapi.json`, projected from the action registry by `@ultimat3/action`. The CLI writes the
// file and compares the bytes; it does not know how an operation is shaped, which is why there
// is no second OpenAPI builder to drift from the one the server serves.

import { buildOpenApi, serializeOpenApi } from '@ultimat3/action';
import type { Manifest } from '@ultimat3/manifest';

export const OPENAPI_FILE = 'openapi.json';

/** The exact bytes on disk — deterministic, so `x verify` can compare them literally. */
export const openApiJson = (manifest: Manifest): string =>
  serializeOpenApi(buildOpenApi({ title: manifest.app.name, version: manifest.app.version }));
