// Compile-time pins for the typed query hook. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level assertion written there can never fail. This module emits nothing and exports
// nothing anybody imports — a regression is a build error, the only enforcement that counts
// (axiom 3). What it protects is the whole reason `liveHookFor` exists: `useLiveFeed({ orgId })`
// carrying the query's own input and row types. Lose that and the hook still runs — it just
// stops catching the typo that makes a subscription match nothing.

import type { Query } from '@ultimat3/query';
import type { LiveHandle, Unsubscribe } from './client';
import type { LiveRows } from './hooks';
import type { LiveQueryHook, LiveQuerySource } from './query-hook';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The input type a `Query` accepts, read off its call signature rather than its schema. */
type InputOf<Q> = Q extends (input: infer I, options?: never) => unknown ? I : never;

interface FeedInput {
  readonly orgId: string;
}

interface FeedRow {
  readonly id: string;
  readonly title: string;
}

type FeedHook = LiveQueryHook<FeedInput, FeedRow>;

/** The hook takes the query's own input, as a value or as the thunk `useLive` reads once. */
export type _HookInputIsTheQueryInput = Assert<
  Equals<Parameters<FeedHook>[0], FeedInput | (() => FeedInput)>
>;

/** …and answers in the query's own row type, not the wire's `Row`. */
export type _HookRowsAreTheQueryRows = Assert<
  Equals<ReturnType<ReturnType<FeedHook>>, readonly FeedRow[]>
>;

/**
 * A wrong key is refused. Written as a negative because that is the failure being pinned: a hook
 * whose input widened to `JsonValue` would still compile everywhere and silently accept `orgIdd`.
 */
export type _WrongInputKeyIsRefused = Assert<
  [{ readonly orgIdd: string }] extends [Parameters<FeedHook>[0]] ? false : true
>;

/**
 * The seam itself: a declared `@ultimat3/query` `Query` assigns to the structural shape
 * `liveHookFor` binds. Named structurally rather than imported as a value, so this stays the one
 * place a change to `Query` — losing `isLive`, ceasing to be callable — fails, instead of every
 * component call site in every app.
 */
export type _DeclaredQueryBindsToTheHook = Assert<
  [Query] extends [LiveQuerySource<InputOf<Query>, Record<string, unknown>>] ? true : false
>;

/**
 * The handle `LiveClient.useLive()` returns must stay `Disposable`, or `using sub =
 * client.useLive(...)` silently degrades to "never unsubscribes" the moment someone drops the
 * `[Symbol.dispose]` member while refactoring `unsubscribe`.
 */
export type _LiveHandleIsDisposable = Assert<[LiveHandle] extends [Disposable] ? true : false>;

/** Same pin, one layer up: the hook's callable result set must stay `Disposable` too. */
export type _LiveRowsIsDisposable = Assert<[LiveRows] extends [Disposable] ? true : false>;

/** `channel.subscribe()`'s return must stay both callable and `Disposable`. */
export type _UnsubscribeIsDisposable = Assert<[Unsubscribe] extends [Disposable] ? true : false>;
