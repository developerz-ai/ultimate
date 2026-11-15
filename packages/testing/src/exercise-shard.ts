// `x exercise --shard i/n`: which primitives and route loads one of n processes runs. A pure
// function of the position in the registry's own order, so shard 3 of 8 is the same slice on every
// machine — and each subject's tenant pair is its own, so the slices share no row.

/** 1-based, as a CI matrix counts: `{ index: 2, total: 4 }` is the second of four. */
export interface ExerciseShard {
  readonly index: number;
  readonly total: number;
}

/** Whether the subject at `position` (primitives first, then routes) is this shard's. */
export const inShard = (position: number, shard: ExerciseShard | undefined): boolean =>
  shard === undefined || position % shard.total === shard.index - 1;
