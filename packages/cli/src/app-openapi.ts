// `openapi.json`, projected from the two registries: the actions by `@ultimat3/action`'s
// `buildOpenApi`, the queries by `@ultimat3/query`'s `queryOpenApiPaths`. The CLI merges the two
// `paths` maps — those packages are one tier and cannot compose each other — writes the file and
// compares the bytes; it does not know how an operation is shaped, which is why there is no third
// OpenAPI builder to drift from the ones the packages serve. Until 2026-09 only the actions were
// here, and every `GET /_x/query/<name>` the server mounted was a route the spec had never heard of.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { OpenApiDocument } from '@ultimat3/action';
import {
  apiDeclaration,
  buildOpenApi,
  completeOpenApi,
  mountOpenApi,
  serializeOpenApi,
} from '@ultimat3/action';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { bearerMount } from '@ultimat3/http';
import type { Manifest } from '@ultimat3/manifest';
import { queryOpenApiPaths } from '@ultimat3/query';
import { apiRoutes } from './api-routes';
import type { Finding } from './output';

export const OPENAPI_FILE = 'openapi.json';

/** One generated document: its app-root file and its exact bytes. */
export interface OpenApiArtifact {
  readonly file: string;
  readonly text: string;
}

/** Both registries in one document — the shape every app had before it declared `openapi`. */
function mergedDocument(manifest: Manifest): OpenApiDocument {
  const document = buildOpenApi({ title: manifest.app.name, version: manifest.app.version });
  // Action paths are `/api/...`, query paths `/_x/query/...`: disjoint by prefix, so the spread
  // can never shadow one with the other. `serializeOpenApi` sorts the merged keys.
  return { ...document, paths: { ...document.paths, ...queryOpenApiPaths() } };
}

/**
 * The exact bytes on disk — deterministic, so `x verify` can compare them literally. An app that
 * declared `defineApi({ openapi })` gets the COMPLETE document (its info and servers, security
 * schemes, 401/429 on authenticated operations); one that did not keeps the bytes it had.
 */
export const openApiJson = (manifest: Manifest): string => {
  const merged = mergedDocument(manifest);
  const declared = apiDeclaration();
  if (declared.openapi === undefined) return serializeOpenApi(merged);
  return serializeOpenApi(
    completeOpenApi(merged, {
      declared: declared.openapi,
      routes: apiRoutes(),
      bearer: (declared.http?.mounts ?? []).length > 0,
    }),
  );
};

/**
 * Every document the app maintains: `openapi.json`, then one per bearer mount that names a file
 * (`mounts: [{ prefix: '/v1', openapi: 'openapi.v1.json', … }]`) — only the cut, at the mounted
 * paths. The mount is built once here as the boot builds it, so a scope naming a primitive nothing
 * registered is refused by `x manifest` as it would be by the server (`X_BEARER_MOUNT_INVALID`).
 */
export const openApiArtifacts = (manifest: Manifest): readonly OpenApiArtifact[] => {
  const declared = apiDeclaration();
  const mounts = (declared.http?.mounts ?? []).filter((mount) => mount.openapi !== undefined);
  const artifacts: OpenApiArtifact[] = [{ file: OPENAPI_FILE, text: openApiJson(manifest) }];
  if (mounts.length === 0) return artifacts;
  const merged = mergedDocument(manifest);
  const routes = apiRoutes();
  for (const mount of mounts) {
    bearerMount({ prefix: mount.prefix, routes, scopes: mount.scopes, resolveToken: () => null });
    artifacts.push({
      file: mount.openapi ?? OPENAPI_FILE,
      text: serializeOpenApi(
        mountOpenApi(merged, { declared: declared.openapi ?? {}, mount, routes }),
      ),
    });
  }
  return artifacts;
};

/**
 * The typed client is generated from `openapi.json`, so a stale spec ships a wrong client. One
 * check, read by `x verify`'s `manifest` step AND `x manifest --check` — which looked at
 * `x.manifest.json` alone and answered "fresh" over a spec the gate refused. A mount's document
 * is checked the same way, and — because the app ASKED for it by naming the file — is stale when
 * it is missing, where an absent `openapi.json` is an app that does not maintain one.
 */
export async function openApiStaleness(
  root: string,
  manifest: Manifest,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const artifact of openApiArtifacts(manifest)) {
    const path = join(root, artifact.file);
    const exists = await Bun.file(path).exists();
    if (!exists && artifact.file === OPENAPI_FILE) continue;
    if (exists && (await Bun.file(path).text()) === artifact.text) continue;
    findings.push({
      code: 'X_MANIFEST_STALE',
      cause: exists
        ? `${artifact.file} does not match the actions the code registers`
        : `${artifact.file} is declared by a bearer mount and has not been written`,
      fix: 'x manifest',
      docs: ERROR_DOCS_URL,
      at: artifact.file,
    });
  }
  return findings;
}
