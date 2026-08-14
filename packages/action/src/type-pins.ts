// Compile-time pins for the erased action view. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Action, AnyAction } from './action';
import type { ClientMethod } from './client';
import type { ActionJobHandle } from './job-handle';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type PublishInput = StandardSchemaV1<{ readonly postId: string }>;
type PublishOutput = StandardSchemaV1<{ readonly published: boolean }>;
type PublishPost = Action<PublishInput, PublishOutput>;

/**
 * The registry hands back `AnyAction` and nothing else, so the erased view has to project every
 * surface — the queue included. Written as the return type rather than `'job' in keyof` because
 * an `AnyAction['job']` that answered the wrong shape would satisfy a key check.
 */
export type _ErasedViewProjectsAJobHandle = Assert<
  Equals<ReturnType<AnyAction['job']>, ActionJobHandle>
>;

/** …and the typed action still narrows it to its own schemas, which is what `.job()` is for. */
export type _TypedActionNarrowsTheJobHandle = Assert<
  Equals<ReturnType<PublishPost['job']>, ActionJobHandle<PublishInput, PublishOutput>>
>;

/**
 * Why `client()` is NOT on the erased view, pinned rather than asserted in a comment: a
 * `ClientMethod` is a function type, so its input is checked contravariantly and the erased
 * `(input: unknown) => …` is a supertype of no concrete action's method. Spelling `ClientMethod`
 * with method syntax — or with an `any` — would flip this to `true` and make the asymmetry
 * between `job()` and `client()` look arbitrary.
 */
export type _ErasedClientIsNotASupertype = Assert<
  ClientMethod<PublishInput, PublishOutput> extends ClientMethod<StandardSchemaV1, StandardSchemaV1>
    ? false
    : true
>;
