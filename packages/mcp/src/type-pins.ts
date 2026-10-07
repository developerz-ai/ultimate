// Compile-time pins for this package's public types. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type {
  McpListParams as CoreListParams,
  McpAnnotationHints,
  McpExposureDeclaration,
} from '@ultimat3/core';
import type { ProjectablePrimitive } from './from-action';
import type { McpListParams } from './list-params';
import type { McpToolAnnotations } from './registry';

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

type Projected = NonNullable<ProjectablePrimitive['mcp']>;

/**
 * 25.0.0: the projection reads core's ONE `mcp` block. `McpExposure` restated it here, a field
 * looser (`expose?`) than the block an action or query is held to; a twin coming back as a
 * different shape flips this to `false`.
 */
export type _ProjectionReadsCoresBlock = Assert<Identical<Projected, McpExposureDeclaration>>;

/**
 * 25.0.0 (plan 101, M4): a projected tool is named by its primitive's `name` and by nothing
 * else. `McpExposure.name` was a second naming field no declaration could set; one coming back
 * on core's block flips this to `false`.
 */
export type _McpBlockCarriesNoName = Assert<Equals<Extract<keyof Projected, 'name'>, never>>;

/**
 * The tool's own wire types (`McpTool.annotations`, `McpTool.listParams`) are what the block's
 * fields become, so they must stay the block's shapes exactly: a hint or a whitelist key added
 * on one side only is a declaration the other silently drops.
 */
export type _ToolAnnotationsAreTheBlocks = Assert<
  Identical<McpToolAnnotations, McpAnnotationHints>
>;
export type _ToolListParamsAreTheBlocks = Assert<Identical<McpListParams, CoreListParams>>;
