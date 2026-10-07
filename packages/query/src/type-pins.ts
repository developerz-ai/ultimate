// Compile-time pins for this package's public surface. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { AnyQuery, Query } from './query';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * O-tool, 25.0.0: a query projects no MCP tool of its own — `@ultimat3/mcp`'s `toolFrom` is
 * the one projection, and a tier-3 `.tool()` could only ever be a second one. A `tool` member
 * coming back on either view flips these to `false`.
 */
export type _AQueryHasNoToolTwin = Assert<Equals<Extract<keyof AnyQuery, 'tool'>, never>>;
export type _ATypedQueryHasNoToolTwin = Assert<Equals<Extract<keyof Query, 'tool'>, never>>;

/**
 * 25.0.0 (plan 101, M5): the deprecation TYPES are `@ultimat3/core`'s alone, as the helpers are.
 * A runtime test cannot see a type re-export, so each is an expected error: a re-export coming
 * back makes the directive unused, which `tsc` refuses.
 */
// @ts-expect-error — `Deprecation` is imported from `@ultimat3/core`, never from this barrel.
export type _NoDeprecationReexport = import('./index').Deprecation;
// @ts-expect-error — `DeprecationField` is imported from `@ultimat3/core`.
export type _NoDeprecationFieldReexport = import('./index').DeprecationField;
// @ts-expect-error — `DeprecationRender` is imported from `@ultimat3/core`.
export type _NoDeprecationRenderReexport = import('./index').DeprecationRender;
