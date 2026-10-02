// Compile-time pin: the documented `rpc<Api['actions']>` idiom at 300 actions in 100 modules.
// Source, not a `.test.ts`, for `type-pins.ts`'s reason — `tsc -b` never reads a test file. Types
// only: nothing here is emitted, and a regression is TS2589 in the `typecheck` step.
//
// The shape is the OBSERVED one (issue #534): the limit was never the action count, it was the
// number of MODULES in one `defineApi` list — 47 passed and 48 failed, whatever they exported.

import type { NumberSchema, ObjectSchema, StringSchema } from '@ultimat3/schema';
import type { Action } from './action';
import type { rpc } from './client';
import type { defineApi } from './define-api';

type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Verb = 'create' | 'update' | 'archive';

/** Distinct per module (`m7`), so no two modules collapse into one instantiation. */
type ScaleInput<N extends number> = ObjectSchema<
  {
    readonly id: StringSchema;
    readonly title: StringSchema;
    readonly nested: ObjectSchema<{ readonly label: StringSchema; readonly rank: NumberSchema }>;
  } & { readonly [K in `m${N}`]: NumberSchema }
>;

type ScaleOutput<N extends number> = ObjectSchema<
  { readonly id: StringSchema } & { readonly [K in `out${N}`]: StringSchema }
>;

/** A feature module as `import * as` sees one: its actions, and a helper that is not one. */
type ActionModule<N extends number> = {
  readonly [K in `${Verb}Thing${N}`]: Action<ScaleInput<N>, ScaleOutput<N>>;
} & { readonly [K in `helper${N}`]: (value: number) => number };

/** `@ultimat3/query` is sideways, so a read is stood in for by the two members `Merge` reads. */
type QueryModule<N extends number> = {
  readonly [K in `listRows${N}` | `oneRow${N}`]: { readonly kind: 'query'; readonly name: string };
};

/** `[Module<0>, …, Module<TCount - 1>]`. A tail call, so the list length costs no depth here. */
type ActionModules<
  TCount extends number,
  TAcc extends readonly unknown[] = [],
> = TAcc['length'] extends TCount
  ? TAcc
  : ActionModules<TCount, [...TAcc, ActionModule<TAcc['length']>]>;

type QueryModules<
  TCount extends number,
  TAcc extends readonly unknown[] = [],
> = TAcc['length'] extends TCount
  ? TAcc
  : QueryModules<TCount, [...TAcc, QueryModule<TAcc['length']>]>;

/** 100 modules of 3 actions, 50 modules of 2 reads — through `defineApi`'s own signature. */
type ScaleApi = ReturnType<
  typeof defineApi<{
    readonly actions: ActionModules<100>;
    readonly queries: QueryModules<50>;
  }>
>;

/** The idiom itself: its `ActionMap` constraint is where TS2589 was raised. */
type ScaleClient = ReturnType<typeof rpc<ScaleApi['actions']>>;

export type _EveryModuleReachesTheClient = Assert<
  'createThing0' | 'updateThing47' | 'archiveThing99' extends keyof ScaleClient ? true : false
>;

/** 300, counted: a `Merge` that dropped a module would still pass the three names above. */
export type _TheClientHasExactlyTheRegisteredActions = Assert<
  Equals<keyof ScaleClient, ActionName>
>;

type ActionName = {
  [N in keyof ActionModules<100> & `${number}`]: `${Verb}Thing${N}`;
}[keyof ActionModules<100> & `${number}`];

/** A helper exported beside the actions is not a method — the server never registered it. */
export type _AHelperIsNotAClientMethod = Assert<'helper0' extends keyof ScaleClient ? false : true>;

/** One call, both sides inferred from the LAST module's own schemas. */
export type _TheLastActionKeepsItsInput = Assert<
  Equals<
    Parameters<ScaleClient['archiveThing99']>[0],
    {
      readonly id: string;
      readonly title: string;
      readonly nested: { readonly label: string; readonly rank: number };
      readonly m99: number;
    }
  >
>;

export type _TheLastActionKeepsItsOutput = Assert<
  Equals<
    Awaited<ReturnType<ScaleClient['archiveThing99']>>,
    { readonly id: string; readonly out99: string }
  >
>;

/** `Api['queries']` is the same `Merge`, and regresses with it. */
export type _EveryQueryModuleIsMerged = Assert<
  Equals<
    keyof ScaleApi['queries'],
    {
      [N in keyof QueryModules<50> & `${number}`]: `listRows${N}` | `oneRow${N}`;
    }[keyof QueryModules<50> & `${number}`]
  >
>;

/** No list at all, and an empty one, are both the empty map — never `unknown`. */
type EmptyApi = ReturnType<typeof defineApi<{ readonly actions: readonly [] }>>;

export type _AnEmptyListIsAnEmptyMap = Assert<
  Equals<keyof EmptyApi['actions'] | keyof EmptyApi['queries'], never>
>;

export type _AnEmptyMapStillSatisfiesRpc = ReturnType<typeof rpc<EmptyApi['actions']>>;

/** One module handed over bare, not in a list — the other spelling `ApiModules` allows. */
type BareApi = ReturnType<typeof defineApi<{ readonly actions: ActionModule<7> }>>;

export type _ABareModuleIsRegisteredToo = Assert<Equals<keyof BareApi['actions'], `${Verb}Thing7`>>;
