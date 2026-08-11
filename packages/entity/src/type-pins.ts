// Compile-time pins for the two type positions this package has already regressed in. Source, not
// a `.test.ts`, on purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a
// test file and a type-level assertion written there can never fail. Everything below is erased —
// the module emits nothing — and a regression is a build error, which is the only kind of
// enforcement this repo counts (axiom 3).

import type { EntitySet } from './database';
import type { Entity, EntityCore, EntityInit } from './entity';
import type { ColumnExpr, InvariantColumns } from './expr';
import type { Invariant, InvariantDef } from './invariants';
import type { AnyColumn, RowOf } from './types';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/**
 * Shaped like a declared column set; only its keys and its derived row take part. A type alias,
 * not an interface: only an alias gets the implicit index signature `ColumnMap` asks for.
 */
type PinColumns = {
  readonly title: AnyColumn;
  readonly price: AnyColumn;
};

type PinRow = RowOf<PinColumns>;

/** Ambient: a type query needs a value to name, and an ambient declaration emits nothing. */
declare const pinned: InvariantColumns<PinColumns>;

/**
 * The defect: `InvariantColumns` was `{ readonly [column: string]: ColumnExpr }`, so under
 * `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined` and every generated
 * entity needed a `!`. Written as a property access rather than an indexed-access type, because
 * that is the position the flag widens.
 */
export type PinColumnIsNotOptional = Assert<undefined extends typeof pinned.title ? false : true>;

export type PinColumnIsAColumnExpr = Assert<
  [typeof pinned.title] extends [ColumnExpr] ? true : false
>;

/** An index signature would make every string a key, so a typo would type-check. */
export type PinUnknownColumnIsNotAKey = Assert<
  'titel' extends keyof InvariantColumns<PinColumns> ? false : true
>;

/** `unique()` and `satisfies()` name columns as strings, so they need the same protection. */
export type PinHelpersTakeDeclaredColumns = Assert<
  readonly 'titel'[] extends Parameters<InvariantColumns<PinColumns>['unique']>[0] ? false : true
>;

/**
 * `invariants` is one callback over the whole list, never an array of `(c) => …` builders: a
 * per-element builder is a call TypeScript checks before `C` is fixed, so `C` fell back to its
 * constraint and the mapped type above never reached the author.
 */
export type PinInvariantsIsOneCallback = Assert<
  EntityInit<PinColumns>['invariants'] extends
    | ((columns: InvariantColumns<PinColumns>) => readonly InvariantDef[])
    | undefined
    ? true
    : false
>;

/**
 * `Invariant<T>.holds` is a method, not a `readonly holds: (row: T) => boolean` property. A
 * function-typed property is checked contravariantly, which made `Invariant<PinRow>` unassignable
 * to `Invariant<unknown>`, `Entity<PinRow, C>` unassignable to `EntityCore`, and so every
 * `database({ … })` call degrade to `Table<unknown>` — one position, 36 cascading errors.
 */
export type PinInvariantIsBivariant = Assert<
  [Invariant<PinRow>] extends [Invariant<unknown>] ? true : false
>;

export type PinEntityIsAnEntityCore = Assert<
  [Entity<PinRow, PinColumns>] extends [EntityCore] ? true : false
>;

export type PinEntityMapIsAnEntitySet = Assert<
  [{ readonly post: Entity<PinRow, PinColumns> }] extends [EntitySet] ? true : false
>;
