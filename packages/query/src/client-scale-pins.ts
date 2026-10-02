// Compile-time pin: `queryClient<Api['queries']>` at 100 reads in 50 modules. Source, not a
// `.test.ts` — `tsconfig.json` excludes those, so `tsc -b` would never read the claim. Types only:
// nothing here is emitted, and a regression is a build error in the `typecheck` step.
//
// `QueryClient` is its own mapped type and regresses on its own. `defineApi` is `@ultimat3/action`'s
// (sideways), so the map is spelled the way its `Merge` hands it over: one intersection of every
// module's registered reads. `@ultimat3/action`'s `client-scale-pins.ts` holds the `Merge` half.

import type { NumberSchema, ObjectSchema, StringSchema } from '@ultimat3/schema';
import type { queryClient } from './client';
import type { Page } from './pagination';
import type { Query } from './query';

type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Distinct per module, so no two modules collapse into one instantiation. */
type ScaleInput<N extends number> = ObjectSchema<
  { readonly orgId: StringSchema; readonly limit: NumberSchema } & {
    readonly [K in `q${N}`]: StringSchema;
  }
>;

type ScaleRow<N extends number> = { readonly id: string } & { readonly [K in `col${N}`]: number };

/** One feature's reads: a list and a `single: true`, the two methods `QueryClient` projects. */
type QueryModule<N extends number> = {
  readonly [K in `listRows${N}`]: Query<ScaleInput<N>, ScaleRow<N>>;
} & { readonly [K in `oneRow${N}`]: Query<ScaleInput<N>, ScaleRow<N>, true> };

/** `Module<0> & … & Module<TCount - 1>`. A tail call, so the count costs no depth here. */
type MergedQueries<
  TCount extends number,
  TSeen extends readonly unknown[] = [],
  TMap = unknown,
> = TSeen['length'] extends TCount
  ? TMap
  : MergedQueries<TCount, [...TSeen, unknown], TMap & QueryModule<TSeen['length']>>;

type ScaleQueries = MergedQueries<50>;

/** The idiom itself, through `queryClient`'s own `QueryMap` constraint. */
type ScaleClient = ReturnType<typeof queryClient<ScaleQueries>>;

export type _EveryModuleReachesTheClient = Assert<
  'listRows0' | 'oneRow24' | 'listRows49' extends keyof ScaleClient ? true : false
>;

export type _TheClientHasExactlyTheMergedReads = Assert<
  Equals<keyof ScaleClient, keyof ScaleQueries>
>;

type LastInput = { readonly orgId: string; readonly limit: number; readonly q49: string };

/** One call of each shape, read off the LAST module's own declaration. */
export type _AListReadAnswersRows = Assert<
  Equals<
    [Parameters<ScaleClient['listRows49']>[0], Awaited<ReturnType<ScaleClient['listRows49']>>],
    [LastInput, readonly ScaleRow<49>[]]
  >
>;

export type _AListReadPages = Assert<
  Equals<Awaited<ReturnType<ScaleClient['listRows49']['page']>>, Page<ScaleRow<49>>>
>;

export type _ASingleReadAnswersTheRow = Assert<
  Equals<
    [Parameters<ScaleClient['oneRow49']>[0], Awaited<ReturnType<ScaleClient['oneRow49']>>],
    [LastInput, ScaleRow<49>]
  >
>;

/** A single read has no `page` — the route refuses the controls, so the method would be a 400. */
export type _ASingleReadHasNoPage = Assert<
  'page' extends keyof ScaleClient['oneRow49'] ? false : true
>;
