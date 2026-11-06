// The scale verdict: one primitive's statement shapes at a small seed and at a large one. A shape
// sent more often when the tables hold more rows is a loop over rows — an N+1 no test named — and
// red, unless `expectedQueryLoop` scoped it, which is reported with its reason. Pure: tallies in.

/** One statement shape in one call: every statement, and the ones no `expectedQueryLoop` covered. */
export interface StatementTally {
  /** `statementFingerprint`: `posts.findById` when attributed, else the collapsed text. */
  readonly fingerprint: string;
  readonly count: number;
  readonly unexpected: number;
  /** The `expectedQueryLoop` reason in force when one of them was sent. */
  readonly expected?: string;
}

/** A shape whose count moved between the two sizes. */
export interface ScaleShape {
  readonly fingerprint: string;
  readonly small: number;
  readonly large: number;
  /** Present on a loop `expectedQueryLoop` declared: why it is deliberate. */
  readonly reason?: string;
}

export type ScaleProof =
  /** No shape grew; `expected` lists the declared loops that did, with their reasons. */
  | { readonly verdict: 'flat'; readonly expected: readonly ScaleShape[] }
  | {
      readonly verdict: 'grows';
      readonly shapes: readonly ScaleShape[];
      readonly expected: readonly ScaleShape[];
    }
  /** A call at one size did not answer as at the other: the counts are not comparable. Never red. */
  | { readonly verdict: 'unproven'; readonly reason: string };

/** Rows a table per tenant at each size: a loop over them sends 2 statements, then 8. */
export const SCALE_SIZES = { small: 2, large: 8 } as const;

/**
 * Per shape, the large run against the small one. Only unexpected statements are judged; a shape
 * that grew only under an `expectedQueryLoop` is listed beside the verdict with its reason. A shape
 * absent at the small size and present at the large one grew from zero.
 */
export function judgeScale(
  small: readonly StatementTally[],
  large: readonly StatementTally[],
): ScaleProof {
  const before = new Map(small.map((tally) => [tally.fingerprint, tally]));
  const shapes: ScaleShape[] = [];
  const expected: ScaleShape[] = [];
  for (const after of large) {
    const was = before.get(after.fingerprint);
    if (after.unexpected > (was?.unexpected ?? 0)) {
      shapes.push({
        fingerprint: after.fingerprint,
        small: was?.unexpected ?? 0,
        large: after.unexpected,
      });
    } else if (after.count > (was?.count ?? 0) && after.expected !== undefined) {
      expected.push({
        fingerprint: after.fingerprint,
        small: was?.count ?? 0,
        large: after.count,
        reason: after.expected,
      });
    }
  }
  const byName = (a: ScaleShape, b: ScaleShape): number =>
    a.fingerprint.localeCompare(b.fingerprint);
  shapes.sort(byName);
  expected.sort(byName);
  return shapes.length === 0
    ? { verdict: 'flat', expected }
    : { verdict: 'grows', shapes, expected };
}
