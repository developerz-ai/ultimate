/**
 * The COMPLETE document an app opts into with `defineApi({ openapi })`: its own `info` and
 * `servers`, its security schemes, and the 401/429 refusals no per-primitive projection can state —
 * none knows the route an operation is mounted as.
 *
 * The security schemes are the ones its routes are reached through; the refusals, the ones an
 * authenticated, limited or metered operation can answer: 401, and 429 with `Retry-After`.
 * Plus the second document a bearer mount publishes: only the cut, at the mounted paths.
 *
 * Built over the merged document (actions AND reads — `@ultimat3/cli` merges the two packages'
 * paths) and over the `Route`s that serve it, so "is this operation authenticated" is the answer
 * `meta.auth` gives the pipeline, never a second derivation. Deterministic like `openapi.ts`: the
 * inputs are sorted and nothing reads the clock or the environment.
 */

import { toOpenApiPath } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { mountedPath, TENANTS_SEGMENT } from '@ultimat3/http';
import type { ApiMount, ApiOpenApi } from './api-declaration';
import type { JsonSchemaObject } from './json-schema';
import type { OpenApiDocument } from './openapi';
import { listingOperationId, tenantsOperation, withTenantParameter } from './openapi-mount-tenant';
import {
  problem,
  RATE_LIMIT_HEADERS,
  RETRY_AFTER_HEADER,
  tooManyDescription,
} from './openapi-problem';

/** `components.securitySchemes` keys. */
export const COOKIE_SCHEME = 'cookie';
export const BEARER_SCHEME = 'bearer';

type Operation = Record<string, unknown>;

const BEARER_SECURITY_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  description: 'A token issued by the app, sent as Authorization: Bearer <token>.',
};

const lower = (method: string): string => method.toLowerCase();

/** `method path` → the route that serves it, the path in the document's `{param}` spelling. */
function routeIndex(routes: readonly Route[]): ReadonlyMap<string, Route> {
  return new Map(
    routes.map((route) => [`${lower(route.method)} ${toOpenApiPath(route.path)}`, route]),
  );
}

interface Refusals {
  readonly scheme: string;
  /**
   * The security requirement's list: empty on the cookie document, the ONE scope a mounted
   * operation needs on a bearer mount's (OpenAPI 3.1 allows role names for a non-OAuth scheme).
   */
  readonly scopes: readonly string[];
  /** The mount's own allowance applies to every operation, whatever the route declares. */
  readonly everyOpLimited: boolean;
  readonly unauthorizedHeaders?: Record<string, unknown>;
}

/**
 * An ACTION's limit is spent inside `invoke`, so its route carries no bucket to read; the operation
 * itself publishes the declaration (`x-ultimate.rateLimit`, `null` when none). A query's route
 * still does, hence both reads above.
 */
function declaresRateLimit(operation: Operation): boolean {
  return declares(operation, 'rateLimit');
}

/**
 * A `meter:` is drawn inside `invoke` too, on every surface, and refuses with `X_METER_EXCEEDED`
 * and a `Retry-After` up to the period's end — on a public operation as on an authenticated one.
 * Published as `x-ultimate.meter`, absent when undeclared.
 */
function declaresMeter(operation: Operation): boolean {
  return declares(operation, 'meter');
}

function declares(operation: Operation, key: 'rateLimit' | 'meter'): boolean {
  const extensions = operation['x-ultimate'];
  if (typeof extensions !== 'object' || extensions === null) return false;
  const declared = (extensions as Record<string, unknown>)[key];
  return declared !== undefined && declared !== null;
}

/** One operation, with its route's refusals and security added. Never mutates `operation`. */
function completeOperation(operation: Operation, route: Route | undefined, refusals: Refusals) {
  const authenticated = route?.meta.auth === 'required';
  const limited =
    refusals.everyOpLimited ||
    route?.meta.rateLimitBucket !== undefined ||
    declaresRateLimit(operation);
  const metered = declaresMeter(operation);
  if (!authenticated && !limited && !metered) return operation;
  const responses = { ...(operation['responses'] as Record<string, unknown>) };
  if (limited) {
    const ok = responses['200'] as Record<string, unknown> | undefined;
    if (ok !== undefined) {
      responses['200'] = {
        ...ok,
        headers: {
          ...(ok['headers'] as Record<string, unknown> | undefined),
          ...RATE_LIMIT_HEADERS,
        },
      };
    }
  }
  if (authenticated) {
    responses['401'] = problem(
      'X_UNAUTHENTICATED — no credential, or one that did not resolve',
      refusals.unauthorizedHeaders,
    );
  }
  // A meter is no bucket: its refusal states the delay to the period's end and no `RateLimit-*`.
  responses['429'] = problem(
    tooManyDescription(authenticated || limited, metered),
    limited ? { ...RETRY_AFTER_HEADER, ...RATE_LIMIT_HEADERS } : RETRY_AFTER_HEADER,
  );
  return {
    ...operation,
    responses,
    ...(authenticated ? { security: [{ [refusals.scheme]: [...refusals.scopes] }] } : {}),
  };
}

function mapOperations(
  paths: Record<string, unknown>,
  visit: (path: string, method: string, operation: Operation) => Operation,
): Record<string, unknown> {
  // `fromEntries`, never `out[path] = …`: a path is a key, and assigning `__proto__` runs a setter.
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item as Record<string, Operation>).map(([method, operation]) => [
          method,
          visit(path, method, operation),
        ]),
      ),
    ]),
  );
}

function infoOf(document: OpenApiDocument, declared: ApiOpenApi) {
  return {
    title: declared.title ?? document.info.title,
    version: declared.version ?? document.info.version,
    ...(declared.description === undefined ? {} : { description: declared.description }),
  };
}

const serversOf = (declared: ApiOpenApi) =>
  declared.servers === undefined || declared.servers.length === 0
    ? {}
    : {
        servers: declared.servers.map((server) => ({
          url: server.url,
          ...(server.description === undefined ? {} : { description: server.description }),
        })),
      };

/**
 * `openapi.json`, complete: the app's `info` and `servers`, a `cookie` security scheme (plus
 * `bearer` when a mount exists — it is the same API reached another way), and 401/429 on every
 * operation its route authenticates.
 */
export function completeOpenApi(
  document: OpenApiDocument,
  input: {
    readonly declared: ApiOpenApi;
    readonly routes: readonly Route[];
    readonly bearer: boolean;
  },
): OpenApiDocument {
  const index = routeIndex(input.routes);
  const paths = mapOperations(document.paths, (path, method, operation) =>
    completeOperation(operation, index.get(`${method} ${path}`), {
      scheme: COOKIE_SCHEME,
      scopes: [],
      everyOpLimited: false,
    }),
  );
  return {
    ...document,
    info: infoOf(document, input.declared),
    ...serversOf(input.declared),
    paths,
    components: {
      ...document.components,
      securitySchemes: {
        [COOKIE_SCHEME]: {
          type: 'apiKey',
          in: 'cookie',
          name: input.declared.sessionCookie ?? 'session',
        },
        ...(input.bearer ? { [BEARER_SCHEME]: BEARER_SECURITY_SCHEME } : {}),
      },
    },
  };
}

/**
 * A bearer mount's own document: only the operations its `scopes` name, re-keyed to the mounted
 * paths, each `bearer`-secured with 401, 404-when-hidden and 429, and only the schemas those
 * operations reference. Each operation's `security` is `[{ bearer: ['<scope>'] }]` — the scope a
 * token needs, also in `x-ultimate.scope` — and the scheme documents the whole scope map.
 */
export function mountOpenApi(
  document: OpenApiDocument,
  input: {
    readonly declared: ApiOpenApi;
    readonly mount: ApiMount;
    readonly routes: readonly Route[];
  },
): OpenApiDocument {
  const { mount } = input;
  const scopeOf = new Map<string, string>();
  for (const [scope, names] of Object.entries(mount.scopes)) {
    for (const name of names) scopeOf.set(name, scope);
  }
  // A `Map`: the key is a route path, and a plain object keyed by one would read `__proto__`.
  const mountedItems = new Map<string, Record<string, unknown>>();
  const tags = new Set<string>();
  // Scope → the operations in THIS document it unlocks: what the scheme documents, so it can never
  // name an operation the document does not carry.
  const unlocks = new Map<string, string[]>();
  const byRoute = [...input.routes].sort((a, b) =>
    `${a.path} ${a.method}` < `${b.path} ${b.method}` ? -1 : 1,
  );
  for (const route of byRoute) {
    const scope = scopeOf.get(route.meta.name);
    if (scope === undefined) continue;
    const method = lower(route.method);
    // The document spells a `:param` template `{param}`; the route table keeps the router's form.
    const documented = toOpenApiPath(route.path);
    const item = (
      Object.hasOwn(document.paths, documented) ? document.paths[documented] : undefined
    ) as Record<string, Operation> | undefined;
    const operation = item?.[method];
    if (operation === undefined) continue;
    const completed = completeOperation(
      operation,
      { ...route, meta: { ...route.meta, auth: 'required' } },
      {
        scheme: BEARER_SCHEME,
        scopes: [scope],
        everyOpLimited: mount.rateLimit !== undefined,
        unauthorizedHeaders: {
          'WWW-Authenticate': { description: 'Bearer', schema: { type: 'string' } },
        },
      },
    );
    const responses = {
      ...(completed['responses'] as Record<string, unknown>),
      '404': problem(
        mount.tenant === undefined
          ? 'X_ROUTE_NOT_FOUND — also the answer for a token without this scope'
          : 'X_ROUTE_NOT_FOUND — also the answer for a token without this scope, or a tenant its person is not in',
      ),
    };
    const extensions = (completed['x-ultimate'] as Record<string, unknown> | undefined) ?? {};
    for (const tag of (completed['tags'] as readonly string[] | undefined) ?? []) tags.add(tag);
    unlocks.set(scope, [...(unlocks.get(scope) ?? []), route.meta.name]);
    const mounted = toOpenApiPath(mountedPath(mount.prefix, route.path));
    const served = { ...completed, responses, 'x-ultimate': { ...extensions, scope } };
    mountedItems.set(mounted, {
      ...mountedItems.get(mounted),
      [method]: mount.tenant === undefined ? served : withTenantParameter(served, mount.tenant.arg),
    });
  }
  const listing = mount.tenant === undefined ? undefined : `${mount.prefix}${TENANTS_SEGMENT}`;
  if (listing !== undefined) {
    // Joined, never replacing: an app's own POST at that path is served, so it stays documented.
    const taken = new Set(
      [...mountedItems.values()].flatMap((item) =>
        Object.values(item as Record<string, Operation>).map(
          (operation) => operation['operationId'],
        ),
      ),
    );
    mountedItems.set(listing, {
      ...mountedItems.get(listing),
      get: tenantsOperation(
        BEARER_SCHEME,
        mount.rateLimit !== undefined,
        listingOperationId(taken),
      ),
    });
  }
  const paths = Object.fromEntries(mountedItems);
  const schemas = referencedSchemas(paths, document.components.schemas);
  return {
    openapi: document.openapi,
    info: infoOf(document, input.declared),
    ...serversOf(input.declared),
    paths,
    components: {
      schemas,
      securitySchemes: { [BEARER_SCHEME]: scopedBearerScheme(unlocks, listing) },
    },
    tags: [...tags].sort().map((name) => ({ name })),
  };
}

/**
 * The mount's `bearer` scheme with its scopes stated. An `http` scheme has no `scopes` field (that
 * is OAuth's `flows`), so they are in the description for a reader and in `x-ultimate.scopes` —
 * scope → operation names, both sorted — for a generator; each operation's requirement names one.
 */
function scopedBearerScheme(
  unlocks: ReadonlyMap<string, readonly string[]>,
  listing: string | undefined,
) {
  const scopes = [...unlocks.keys()].sort();
  const table = scopes.map((scope) => [scope, [...(unlocks.get(scope) ?? [])].sort()] as const);
  const lines = table.map(([scope, names]) => `- \`${scope}\`: ${names.join(', ')}`);
  return {
    ...BEARER_SECURITY_SCHEME,
    description: [
      BEARER_SECURITY_SCHEME.description,
      'Each mounted primitive operation lists the one scope a token needs in its security requirement; a token without it is answered 404.',
      ...(listing === undefined
        ? []
        : [
            `Every operation but one names its tenant in the query string; GET ${listing} needs no scope and names no tenant: any valid token lists the tenants it may name.`,
          ]),
      ...(lines.length === 0 ? [] : ['', 'Scopes:', ...lines]),
    ].join('\n'),
    'x-ultimate': { scopes: Object.fromEntries(table) },
  };
}

/** Every component schema `root` reaches through `$ref`, transitively. */
function referencedSchemas(
  root: unknown,
  schemas: Readonly<Record<string, JsonSchemaObject>>,
): Record<string, JsonSchemaObject> {
  const prefix = '#/components/schemas/';
  const found: Record<string, JsonSchemaObject> = {};
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(prefix)) {
        const name = value.slice(prefix.length);
        const schema = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
        if (schema !== undefined && !Object.hasOwn(found, name)) {
          found[name] = schema;
          pending.push(schema);
        }
      } else {
        pending.push(value);
      }
    }
  }
  return found;
}
