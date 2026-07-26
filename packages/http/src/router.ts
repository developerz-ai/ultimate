// The route table. A segment trie, not a regex list, so matching cost is bounded by
// path depth and precedence is a property of the structure rather than of
// declaration order.
//
// PRECEDENCE (deterministic, tested in router.test.ts):
//   1. static segment   `/posts/new`
//   2. param segment    `/posts/:id`
//   3. wildcard segment `/posts/*rest`  (matches ONE OR MORE remaining segments)
// Depth-first with backtracking: `/posts/new` beats `/posts/:id` even though the
// param branch would also match, and a dead end in the static branch still falls
// back to the param branch. Two routes that would tie are a build error
// (`X_ROUTE_CONFLICT`) rather than a coin flip.
import type { RequestContext } from './context';
import { routeConflict } from './errors';
import type { UltimateRequest } from './request';
import type { CacheHint } from './response';
import type { Schema } from './validate';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';

export type RouteParams = Readonly<Record<string, string>>;

export interface RouteMeta {
  /** Stable id used by rate-limit keys, traces and the manifest. */
  readonly name: string;
  /**
   * Required, never inferred: a route that forgets to declare its auth posture is a
   * type error instead of an accidentally public endpoint.
   */
  readonly auth: 'public' | 'required';
  /** Name of the policy the authz stage must satisfy. Resolved by tier 3. */
  readonly policy?: string;
  /** Validated in the body stage; also what the OpenAPI/MCP emitters read. */
  readonly input?: Schema;
  readonly render?: RenderMode;
  readonly cache?: CacheHint;
  /** Named bucket from `rateLimit.buckets`. */
  readonly rateLimit?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
}

export type RouteHandler = (
  request: UltimateRequest,
  ctx: RequestContext,
) => Response | Promise<Response>;

export interface Route {
  readonly method: HttpMethod;
  /** Leading slash, no trailing slash, segments may be `:param` or `*wildcard`. */
  readonly path: string;
  readonly handler: RouteHandler;
  readonly meta: RouteMeta;
}

export type MatchResult =
  | { readonly ok: true; readonly route: Route; readonly params: RouteParams }
  | { readonly ok: false; readonly reason: 'not-found' }
  | {
      readonly ok: false;
      readonly reason: 'method-not-allowed';
      readonly allow: readonly HttpMethod[];
    };

interface TrieNode {
  readonly statics: Map<string, TrieNode>;
  param: { readonly name: string; readonly node: TrieNode } | undefined;
  wildcard: { readonly name: string; readonly node: TrieNode } | undefined;
  readonly routes: Map<HttpMethod, Route>;
}

export interface RouteTable {
  readonly routes: readonly Route[];
  readonly root: TrieNode;
}

const node = (): TrieNode => ({
  statics: new Map(),
  param: undefined,
  wildcard: undefined,
  routes: new Map(),
});

/** `/a/b/` and `//a//b` both normalise to `/a/b`; `/` stays `/`. */
export const normalizePath = (path: string): string => {
  const trimmed = path.split('/').filter((segment) => segment.length > 0);
  return trimmed.length === 0 ? '/' : `/${trimmed.join('/')}`;
};

const segmentsOf = (path: string): readonly string[] =>
  normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0);

export const createRouter = (routes: readonly Route[]): RouteTable => {
  const root = node();
  for (const route of routes) {
    let current = root;
    const segments = segmentsOf(route.path);
    for (const [index, segment] of segments.entries()) {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (current.param !== undefined && current.param.name !== name) {
          throw routeConflict(
            route.path,
            `segment ${index} is :${current.param.name} in an existing route and :${name} here`,
          );
        }
        current.param = current.param ?? { name, node: node() };
        current = current.param.node;
        continue;
      }
      if (segment.startsWith('*')) {
        const name = segment.slice(1) || 'wildcard';
        if (index !== segments.length - 1) {
          throw routeConflict(route.path, 'a wildcard must be the last segment');
        }
        if (current.wildcard !== undefined && current.wildcard.name !== name) {
          throw routeConflict(route.path, `wildcard is *${current.wildcard.name} elsewhere`);
        }
        current.wildcard = current.wildcard ?? { name, node: node() };
        current = current.wildcard.node;
        continue;
      }
      const existing = current.statics.get(segment);
      const next = existing ?? node();
      if (existing === undefined) current.statics.set(segment, next);
      current = next;
    }
    if (current.routes.has(route.method)) {
      throw routeConflict(route.path, `${route.method} is already handled by another route`);
    }
    current.routes.set(route.method, route);
  }
  return { routes: [...routes], root };
};

interface Candidate {
  readonly node: TrieNode;
  readonly params: RouteParams;
}

/** Terminal nodes reachable for `segments`, in precedence order. */
const candidates = (
  current: TrieNode,
  segments: readonly string[],
  index: number,
  params: RouteParams,
  out: Candidate[],
): void => {
  if (index === segments.length) {
    if (current.routes.size > 0) out.push({ node: current, params });
    return;
  }
  const segment = segments[index];
  if (segment === undefined) return;

  const staticChild = current.statics.get(segment);
  if (staticChild !== undefined) candidates(staticChild, segments, index + 1, params, out);

  if (current.param !== undefined) {
    const next = { ...params, [current.param.name]: decodeURIComponent(segment) };
    candidates(current.param.node, segments, index + 1, next, out);
  }

  if (current.wildcard !== undefined) {
    const rest = segments.slice(index).map(decodeURIComponent).join('/');
    const next = { ...params, [current.wildcard.name]: rest };
    if (current.wildcard.node.routes.size > 0) {
      out.push({ node: current.wildcard.node, params: next });
    }
  }
};

/**
 * HEAD falls back to the GET route: the runtime strips the body, so declaring both
 * would be two ways to do one thing.
 */
const routeFor = (candidate: Candidate, method: HttpMethod): Route | undefined =>
  candidate.node.routes.get(method) ??
  (method === 'HEAD' ? candidate.node.routes.get('GET') : undefined);

export const matchRoute = (table: RouteTable, method: string, pathname: string): MatchResult => {
  const segments = segmentsOf(pathname);
  const found: Candidate[] = [];
  candidates(table.root, segments, 0, {}, found);
  if (found.length === 0) return { ok: false, reason: 'not-found' };

  const wanted = method.toUpperCase() as HttpMethod;
  for (const candidate of found) {
    const route = routeFor(candidate, wanted);
    if (route !== undefined) return { ok: true, route, params: candidate.params };
  }
  const allow = new Set<HttpMethod>();
  for (const candidate of found) for (const key of candidate.node.routes.keys()) allow.add(key);
  if (allow.has('GET')) allow.add('HEAD');
  return { ok: false, reason: 'method-not-allowed', allow: [...allow] };
};

export interface RouteDescription {
  readonly method: HttpMethod;
  readonly path: string;
  readonly name: string;
  readonly params: readonly string[];
  readonly auth: 'public' | 'required';
  readonly policy: string | null;
  readonly render: RenderMode | null;
  readonly rateLimit: string | null;
  readonly tags: readonly string[];
  readonly description: string | null;
  readonly hasInputSchema: boolean;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const paramsOf = (path: string): readonly string[] =>
  segmentsOf(path)
    .filter((segment) => segment.startsWith(':') || segment.startsWith('*'))
    .map((segment) => segment.slice(1));

/** Feeds the `/_x` dashboard, the manifest emitter and `x routes list --json`. */
export const describeRoutes = (table: RouteTable): readonly RouteDescription[] =>
  table.routes
    .map((route) => ({
      method: route.method,
      path: normalizePath(route.path),
      name: route.meta.name,
      params: paramsOf(route.path),
      auth: route.meta.auth,
      policy: route.meta.policy ?? null,
      render: route.meta.render ?? null,
      rateLimit: route.meta.rateLimit ?? null,
      tags: route.meta.tags ?? [],
      description: route.meta.description ?? null,
      hasInputSchema: route.meta.input !== undefined,
    }))
    // Code-unit compare, not localeCompare: the manifest is a build artefact and must
    // be byte-identical across machines and ICU versions.
    .sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method));
