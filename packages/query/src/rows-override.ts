// The rows-override slot: canned rows where a stored declaration's `sql()` is, for a test. Keyed by
// the declaration `read.ts` builds from, read per call after the parse and the policy — so a stub
// answers on every read surface and never decides who may read.

import type { Ctx } from '@ultimat3/core';

/** Rows, or a function of the parsed input and the caller that answers them. */
export type RowsOverride =
  | readonly object[]
  | ((args: {
      readonly input: unknown;
      readonly ctx: Ctx;
    }) => readonly object[] | Promise<readonly object[]>);

const OVERRIDES = new WeakMap<object, RowsOverride>();

/** `undefined` puts the declared `sql()` back. */
export function setRowsOverride(def: object, rows: RowsOverride | undefined): void {
  if (rows === undefined) OVERRIDES.delete(def);
  else OVERRIDES.set(def, rows);
}

export const rowsOverrideOf = (def: object): RowsOverride | undefined => OVERRIDES.get(def);
