/**
 * What an app says about its API as a WHOLE, beside the primitives it registers: how action names
 * become URLs, which bearer-token mounts expose a cut of it, and what its OpenAPI document calls
 * itself. Declared in the one `defineApi()` call and held here, process-wide like the registries,
 * because every reader — the boot that mounts routes, `x manifest` writing `openapi.json` — runs
 * after that module was imported and never has the call's return value in hand.
 */

import type { ActionPathStyle } from '@ultimat3/core';
import type { BearerMountRateLimit, BearerResolver } from '@ultimat3/http';
import { OpenApiConfigInvalidError } from './errors-http';

/** A second door onto a cut of the API, authenticated by `Authorization: Bearer` alone. */
export interface ApiMount {
  /** `'/v1'`. The cut is served there: `POST /v1/create-case`, `GET /v1/case-list`. */
  readonly prefix: string;
  /**
   * Scope → the actions and queries it covers, by export name — the map `defineAppMcp({ scopes })`
   * takes, so one declaration governs both surfaces. Its union is the cut; a token sees a
   * primitive only while it carries that primitive's scope, and anything else answers 404.
   */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  /** The app's token resolver — the SAME function its MCP endpoint is given. */
  readonly resolveToken: BearerResolver;
  /** Requests per window per token, answered with `RateLimit-*` and a 429 + `Retry-After`. */
  readonly rateLimit?: BearerMountRateLimit;
  /**
   * An app-root file this mount's OWN OpenAPI document is written to (`'openapi.v1.json'`): only
   * the cut, at the mounted paths, under a `bearer` security scheme. `x manifest` writes it and
   * `x verify` refuses it stale, exactly as it does `openapi.json`.
   */
  readonly openapi?: string;
}

export interface ApiHttp {
  /** `'readable'`: `signIn` → `/api/sign-in`. Default `'resource'`: `/api/ins/sign`. */
  readonly pathStyle?: ActionPathStyle;
  readonly mounts?: readonly ApiMount[];
}

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
}

/**
 * Declaring this block — any key of it — opts the app's documents into the COMPLETE shape: its
 * own `info`, `servers`, `components.securitySchemes`, and 401 / 429 problem responses on every
 * authenticated operation. Absent, `openapi.json` keeps the bytes it had, so an upgrade does not
 * turn an app's committed contract stale by itself.
 */
export interface ApiOpenApi {
  /** `info.title`. Defaults to the app's name. */
  readonly title?: string;
  /** `info.version` — the API's contract version, not the app's build. Defaults to the app's. */
  readonly version?: string;
  readonly description?: string;
  readonly servers?: readonly OpenApiServer[];
  /** The session cookie the `cookie` security scheme names. Default `'session'`. */
  readonly sessionCookie?: string;
}

export interface ApiDeclaration {
  readonly http?: ApiHttp;
  readonly openapi?: ApiOpenApi;
}

let declared: ApiDeclaration = {};

const DOCUMENT_FILE = /^[A-Za-z0-9._-]+\.json$/;

const isAbsoluteHttp = (url: string): boolean => {
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
};

function assertOpenApi(openapi: ApiOpenApi | undefined, mounts: readonly ApiMount[]): void {
  if (openapi !== undefined) {
    for (const key of ['title', 'version'] as const) {
      const value = openapi[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new OpenApiConfigInvalidError(`${key} is empty`);
      }
    }
    for (const server of openapi.servers ?? []) {
      if (!isAbsoluteHttp(server.url)) {
        throw new OpenApiConfigInvalidError(
          `server ${JSON.stringify(server.url)} is not an absolute http(s) URL`,
        );
      }
    }
  }
  const files = new Set<string>(['openapi.json']);
  for (const mount of mounts) {
    if (mount.openapi === undefined) continue;
    if (!DOCUMENT_FILE.test(mount.openapi) || files.has(mount.openapi)) {
      throw new OpenApiConfigInvalidError(
        `the ${mount.prefix} mount's document ${JSON.stringify(mount.openapi)} is not a distinct app-root .json file name`,
      );
    }
    files.add(mount.openapi);
  }
}

/** Called by `defineApi`. A later call replaces only the sections it declares. */
export function declareApi(next: ApiDeclaration): void {
  assertOpenApi(next.openapi, next.http?.mounts ?? []);
  declared = {
    ...declared,
    ...(next.http === undefined ? {} : { http: next.http }),
    ...(next.openapi === undefined ? {} : { openapi: next.openapi }),
  };
}

/** What the app declared — `{}` for an app that declared nothing beyond its primitives. */
export function apiDeclaration(): ApiDeclaration {
  return declared;
}

/** Test seam, called by `resetActions`. */
export function resetApiDeclaration(): void {
  declared = {};
}
