// Compile-time pins for the hook surface. Source, not a `.test.ts`, on purpose: `tsconfig.json`
// excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a type-level assertion
// written there can never fail. This module emits nothing anybody imports — a regression is a
// build error, the only enforcement that counts (axiom 3).

import type { AsyncState, Row } from '@ultimat3/core';
import type { LiveHandle, Unsubscribe } from './client-contract';
import type { QueryAccessor, QueryRef } from './use-query';
import type { RecordAccessor } from './use-record';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface FeedRow {
  readonly id: string;
  readonly title: string;
}

/**
 * `useQuery` answers core's `AsyncState` over the caller's own row type — the value `@ultimat3/ui`
 * takes as `state`, with no adapter between them (plan 101, decision 10).
 */
export type _QueryAnswersAsyncState = Assert<
  Equals<ReturnType<QueryAccessor<FeedRow>>, AsyncState<readonly FeedRow[]>>
>;

/** …and `useRecord` the same vocabulary, with `undefined` for a record the server removed. */
export type _RecordAnswersAsyncState = Assert<
  Equals<ReturnType<RecordAccessor<FeedRow>>, AsyncState<FeedRow | undefined>>
>;

/**
 * A query ref carries no server field: a `Query` VALUE in an island drags its whole read path into
 * the bundle, so the ref is a name and two declared facts. A `sql` key is refused.
 */
export type _QueryRefHasNoServerHalf = Assert<
  [{ readonly name: string; readonly sql: () => unknown }] extends [Required<QueryRef>]
    ? false
    : true
>;

/** Every handle a caller gets back stays `Disposable`, so `using` releases it on scope exit. */
export type _LiveHandleIsDisposable = Assert<[LiveHandle] extends [Disposable] ? true : false>;
export type _QueryAccessorIsDisposable = Assert<
  [QueryAccessor] extends [Disposable] ? true : false
>;
export type _RecordAccessorIsDisposable = Assert<
  [RecordAccessor<Row>] extends [Disposable] ? true : false
>;
export type _UnsubscribeIsDisposable = Assert<[Unsubscribe] extends [Disposable] ? true : false>;
