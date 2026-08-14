// Compile-time pins for the route's data seam. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { LoadRequirement, RouteContext, RouteData, RouteDefinition } from './route';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type BlogPost = { readonly post: { readonly title: string } };

/**
 * What makes `routeDataFor`'s no-`load` branch sound. `RouteContext` has to BE a `RouteData` —
 * an `interface` is not, because only an alias gets the implicit index signature, and declaring
 * it as one is what turned that branch's `as unknown as TData` into a checked narrowing.
 */
export type _ContextIsRouteData = Assert<RouteContext extends RouteData ? true : false>;

/**
 * A route that loads nothing still declares nothing extra. `LoadRequirement` collapses to
 * `unknown` for the default `TData`, so every route that shipped before `load` existed — and
 * every route that only reads `data.url` / `data.params` — keeps compiling untouched.
 */
export type _DefaultDataNeedsNoLoad = Assert<
  RouteDefinition extends RouteDefinition & LoadRequirement<RouteData> ? true : false
>;

/**
 * …and a `meta` reading a field the context cannot supply forces one. Pinned as the required
 * `load` key rather than "does not compile", because that is the exact thing the intersection
 * adds: without it, `defineRoute<BlogPost>({ meta: (c) => c.data.post.title })` type-checked and
 * rendered `undefined` in a `<title>`.
 */
export type _RicherDataRequiresALoad = Assert<
  undefined extends LoadRequirement<BlogPost>['load'] ? false : true
>;
