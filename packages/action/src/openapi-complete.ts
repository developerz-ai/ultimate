/**
 * The COMPLETE document an app opts into with `defineApi({ openapi })`: its own `info` and
 * `servers`, the security schemes its routes are reached through, and the two refusals every
 * authenticated operation can answer — 401 and 429, with `Retry-After` — which the per-primitive
 * projections cannot state because they do not know the route an operation is mounted as. Plus
 * the second document a bearer mount publishes: only the cut, at the mounted paths.
 *
 * Built over the merged document (actions AND reads — `@ultimat3/cli` merges the two packages'
 * paths) and over the `Route`s that serve it, so "is this operation authenticated" is the answer
 * `meta.auth` gives the pipeline, never a second derivation. Deterministic like `openapi.ts`: the
 * inputs are sorted and nothing reads the clock or the environment.
 */

import type { Route } from '@ultimat3/http';
import { mountedPath } from '@ultimat3/http';
import type { ApiMount, ApiOpenApi } from './api-declaration';
import type { JsonSchemaObject } from './json-schema';
import { PROBLEM_SCHEMA_NAME, schemaRef } from './naming';
import type { OpenApiDocument } from './openapi';

/** `components.securitySchemes` keys. */
export const COOKIE_SCHEME = 'cookie';
export const BEARER_SCHEME = 'bearer';

type Operation = Record<string, unknown>;

const BEARER_SECURITY_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  description: 'A token issued by the app, sent as Authorization: Bearer <token>.',
};

const RATE_LIMIT_HEADERS: Record<string, unknown> = {
  'RateLimit-Limit': {
    description: 'Requests the bucket admits per window.',
    schema: { type: 'integer' },
  },
  'RateLimit-Remaining': {
    description: 'Requests left in the current window.',
    schema: { type: 'integer' },
  },
  'RateLimit-Reset': {
    description: 'Seconds until the bucket is full again.',
    schema: { type: 'integer' },
  },
};

const RETRY_AFTER_HEADER: Record<string, unknown> = {
  'Retry-After': {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', minimum: 1 },
  },
};

function problem(description: string, headers?: Record<string, unknown>): Record<string, unknown> {
  return {
    description,
    ...(headers === undefined ? {} : { headers }),
    content: { 'application/problem+json': { schema: { $ref: schemaRef(PROBLEM_SCHEMA_NAME) } } },
  };
}

const lower = (method: string): string => method.toLowerCase();

/** `method path` → the route that serves it. */
function routeIndex(routes: readonly Route[]): ReadonlyMap<string, Route> {
  return new Map(routes.map((route) => [`${lower(route.method)} ${route.path}`, route]));
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

/** One operation, with its route's refusals and security added. Never mutates `operation`. */
function completeOperation(operation: Operation, route: Route | undefined, refusals: Refusals) {
  const authenticated = route?.meta.auth === 'required';
  const limited = refusals.everyOpLimited || route?.meta.rateLimitBucket !== undefined;
  if (!authenticated && !limited) return operation;
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
  responses['429'] = problem(
    'X_RATE_LIMITED — retry after Retry-After seconds',
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
    const item = (
      Object.hasOwn(document.paths, route.path) ? document.paths[route.path] : undefined
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
      '404': problem('X_ROUTE_NOT_FOUND — also the answer for a token without this scope'),
    };
    const extensions = (completed['x-ultimate'] as Record<string, unknown> | undefined) ?? {};
    for (const tag of (completed['tags'] as readonly string[] | undefined) ?? []) tags.add(tag);
    unlocks.set(scope, [...(unlocks.get(scope) ?? []), route.meta.name]);
    const mounted = mountedPath(mount.prefix, route.path);
    mountedItems.set(mounted, {
      ...mountedItems.get(mounted),
      [method]: { ...completed, responses, 'x-ultimate': { ...extensions, scope } },
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
      securitySchemes: { [BEARER_SCHEME]: scopedBearerScheme(unlocks) },
    },
    tags: [...tags].sort().map((name) => ({ name })),
  };
}

/**
 * The mount's `bearer` scheme with its scopes stated. An `http` scheme has no `scopes` field (that
 * is OAuth's `flows`), so they are in the description for a reader and in `x-ultimate.scopes` —
 * scope → operation names, both sorted — for a generator; each operation's requirement names one.
 */
function scopedBearerScheme(unlocks: ReadonlyMap<string, readonly string[]>) {
  const scopes = [...unlocks.keys()].sort();
  const table = scopes.map((scope) => [scope, [...(unlocks.get(scope) ?? [])].sort()] as const);
  const lines = table.map(([scope, names]) => `- \`${scope}\`: ${names.join(', ')}`);
  return {
    ...BEARER_SECURITY_SCHEME,
    description: [
      BEARER_SECURITY_SCHEME.description,
      'Each operation lists the one scope a token needs in its security requirement; a token without it is answered 404.',
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
