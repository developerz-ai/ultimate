// Compile-time pins for this package's public types. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { McpExposure } from './from-action';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 25.0.0 (plan 101, M4): a projected tool is named by its primitive's `name` and by nothing
 * else. `McpExposure.name` was a second naming field no declaration could set; one coming back
 * flips this to `false`.
 */
export type _McpExposureCarriesNoName = Assert<Equals<Extract<keyof McpExposure, 'name'>, never>>;
