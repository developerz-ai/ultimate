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
import type { RenderMode } from '@ultimat3/core';
import type { RequestContext } from './context';
import { routeConflict } from './errors';
import type { Bucket } from './rate-limit';
import type { UltimateRequest } from './request';
import type { CacheHint } from './response';
import { assertRouteCache } from './route-cache';
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
  /**
   * Which layer evaluates `policy`. `'pipeline'` — the default, and what a page route
   * wants — means the `authz` stage decides through `ServerHooks.authorize`. `'handler'`
   * means the handler is the one evaluation and the stage must not pre-judge.
   *
   * An action route says `'handler'` because `invoke` loads the row a row-level rule
   * decides about, and the stage cannot: deciding here too would evaluate the same policy
   * with `row: null`, deny the row's own author, and never reach the evaluation that had
   * the row. Two authz systems is how every Meteor-like framework died — this field is
   * which one is the system.
   */
  readonly enforcedBy?: 'pipeline' | 'handler';
  /** Validated in the body stage; also what the OpenAPI/MCP emitters read. */
  readonly input?: Schema;
  readonly render?: RenderMode;
  readonly cache?: CacheHint;
  /** Named bucket from `rateLimit.buckets`. */
  readonly rateLimit?: string;
  /**
   * The numbers that bucket MUST hold, when the route brings its own. Naming a bucket nothing
   * defines is how a declared limit becomes the `default` one: the name fell through
   * `bucketFor`, so an endpoint declaring 5 ran on 120. `withRouteBuckets` registers this into
   * the limiter's table at construction — the one point where routes and config meet — and
   * refuses a configured bucket of the same name that says something else.
   */
  readonly rateLimitBucket?: Bucket;
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
    }
  /** A param or wildcard segment the request wrote as invalid percent-encoding. */
  | { readonly ok: false; readonly reason: 'path-invalid'; readonly segment: string };

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
    // Before the trie is touched: a hint that cannot be emitted is refused where it was WRITTEN,
    // not on the response path — `cacheControl` is total there by design, so the alternative is a
    // log line once per request and a response that quietly falls back to heuristic caching.
    assertRouteCache(route.meta.cache, route.meta.name, route.path);
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

/** The walk's accumulator: the terminals it reached, and why a branch it could not take failed. */
interface Search {
  readonly out: Candidate[];
  /** First raw segment that would not percent-decode. Only set where a decode was attempted. */
  undecodable: string | undefined;
}

/**
 * `undefined` instead of the bare `URIError` `decodeURIComponent('%ZZ')` throws. A pathname is
 * whatever the client typed, and an exception from the match would leave the pipeline with
 * `X_INTERNAL` — a 500, and a page for the on-call, for a request only the caller can fix.
 */
const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/** Terminal nodes reachable for `segments`, in precedence order. */
const candidates = (
  current: TrieNode,
  segments: readonly string[],
  index: number,
  params: RouteParams,
  search: Search,
): void => {
  if (index === segments.length) {
    if (current.routes.size > 0) search.out.push({ node: current, params });
    return;
  }
  const segment = segments[index];
  if (segment === undefined) return;

  // Static segments are compared raw, never decoded, so a malformed escape only ever fails the
  // branch that would have decoded it: a path that reaches no param or wildcard is the 404 it
  // always was, and a static route still wins the precedence it always won.
  const staticChild = current.statics.get(segment);
  if (staticChild !== undefined) candidates(staticChild, segments, index + 1, params, search);

  if (current.param !== undefined) {
    const value = decodeSegment(segment);
    if (value === undefined) search.undecodable ??= segment;
    else {
      const next = { ...params, [current.param.name]: value };
      candidates(current.param.node, segments, index + 1, next, search);
    }
  }

  if (current.wildcard !== undefined) {
    const tail = segments.slice(index);
    const decoded = tail.map(decodeSegment);
    // `-1` indexes to `undefined`, so this is "the first segment that failed, or none".
    const bad = tail[decoded.indexOf(undefined)];
    if (bad !== undefined) search.undecodable ??= bad;
    else if (current.wildcard.node.routes.size > 0) {
      const next = { ...params, [current.wildcard.name]: decoded.join('/') };
      search.out.push({ node: current.wildcard.node, params: next });
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
  const search: Search = { out: [], undecodable: undefined };
  candidates(table.root, segments, 0, {}, search);
  const found = search.out;
  // A refused decode is only the answer when nothing matched: another branch reaching a route
  // means the request named something real, and the failed decode was a road not taken.
  if (found.length === 0) {
    const { undecodable } = search;
    if (undecodable !== undefined)
      return { ok: false, reason: 'path-invalid', segment: undecodable };
    return { ok: false, reason: 'not-found' };
  }

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
  /** Named, not inferred: a policy with no stated evaluator reads as an unguarded one. */
  readonly enforcedBy: 'pipeline' | 'handler';
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
      enforcedBy: route.meta.enforcedBy ?? 'pipeline',
      render: route.meta.render ?? null,
      rateLimit: route.meta.rateLimit ?? null,
      tags: route.meta.tags ?? [],
      description: route.meta.description ?? null,
      hasInputSchema: route.meta.input !== undefined,
    }))
    // Code-unit compare, not localeCompare: the manifest is a build artefact and must
    // be byte-identical across machines and ICU versions.
    .sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method));
