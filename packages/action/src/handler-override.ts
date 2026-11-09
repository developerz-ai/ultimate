// The handler-override slot: a stored declaration's `handle`, replaced for a test. Keyed by the
// declaration `invoke` runs, read at call time — by `invoke` for a plain action and by the drain
// for a stream-declaring one — so every surface reaches the double through the one execution path.

import type { Ctx } from '@ultimat3/core';

/** What stands where `handle` is: the declaration's own argument shape, any answer. */
export type HandlerOverride = (args: { readonly input: unknown; readonly ctx: Ctx }) => unknown;

const OVERRIDES = new WeakMap<object, HandlerOverride>();

/** `undefined` puts the declared handler back. */
export function setHandlerOverride(def: object, handle: HandlerOverride | undefined): void {
  if (handle === undefined) OVERRIDES.delete(def);
  else OVERRIDES.set(def, handle);
}

export const handlerOverrideOf = (def: object): HandlerOverride | undefined => OVERRIDES.get(def);
