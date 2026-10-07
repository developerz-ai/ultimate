// Compile-time pins for this package's public surface. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { McpExposureDeclaration } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AnyQuery, Query, QueryDef } from './query';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * IDENTICAL, not merely mutually assignable: an object type without an optional key is assignable
 * to one with it and back, so `Equals` cannot see an optional field added on one side only — and
 * every field of the `mcp` block is optional but `expose`.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

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

/**
 * 25.0.0: a query's `mcp` block is core's ONE `McpExposureDeclaration`, on the declaration and on
 * both views. `QueryMcp`, `QueryMcpAnnotations` and `QueryListParams` restated it; a twin coming
 * back on the barrel makes its directive unused, and a field drifting flips the pins to `false`.
 */
export type _QueryDeclaresCoresBlock = Assert<
  Identical<NonNullable<QueryDef<StandardSchemaV1, object>['mcp']>, McpExposureDeclaration>
>;
export type _AnyQueryCarriesCoresBlock = Assert<
  Identical<NonNullable<AnyQuery['mcp']>, McpExposureDeclaration>
>;
export type _TypedQueryCarriesCoresBlock = Assert<
  Identical<NonNullable<Query['mcp']>, McpExposureDeclaration>
>;
// @ts-expect-error — `QueryMcp` is gone: the block is `@ultimat3/core`'s `McpExposureDeclaration`.
export type _NoQueryMcpTwin = import('./index').QueryMcp;
// @ts-expect-error — `QueryMcpAnnotations` is core's `McpAnnotationHints`.
export type _NoQueryMcpAnnotationsTwin = import('./index').QueryMcpAnnotations;
// @ts-expect-error — `QueryListParams` is core's `McpListParams`.
export type _NoQueryListParamsTwin = import('./index').QueryListParams;
