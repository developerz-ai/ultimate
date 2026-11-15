// `x verify merge`'s zero-check steps: each part's own `data.skipReasons`, read back and folded
// with the reason the summed shard counts give, and the same not-strict warning a whole run
// prints. Split from `verify-merge.ts`, which folds the verdict; this folds the reasons.

import type { StepResult } from './output';
import type { VerifyFloor } from './verify-floor';
import { ranNothingReason } from './verify-skip-reason';
import { skipWhy } from './verify-strict';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A part document's `data.skipReasons`, string values only; absent when it carries none. */
export const readPartSkipReasons = (
  data: Record<string, unknown>,
): Readonly<Record<string, string>> | undefined => {
  const raw = data['skipReasons'];
  if (!isRecord(raw)) return undefined;
  const reasons = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return reasons.length === 0 ? undefined : Object.fromEntries(reasons);
};

/**
 * Per merged step, in declared order: the reason a part gave, else — a split step whose shards
 * together ran nothing — the reason the sum gives. Then the steps no `skip` why excuses, on a
 * floor that is not strict.
 */
export function foldSkipReasons(
  steps: readonly StepResult[],
  parts: readonly { readonly skipReasons?: Readonly<Record<string, string>> }[],
  floor: VerifyFloor | undefined,
): { readonly reasons: Readonly<Record<string, string>>; readonly unwaived: readonly string[] } {
  const reasons = new Map<string, string>();
  for (const step of steps) {
    const given = parts.find((part) => part.skipReasons?.[step.name] !== undefined);
    const reason =
      given?.skipReasons?.[step.name] ??
      (step.tests !== undefined && step.tests.ran === 0 ? ranNothingReason(step.tests) : undefined);
    if (reason !== undefined) reasons.set(step.name, reason);
  }
  const unwaived =
    floor?.strict === true
      ? []
      : steps
          .filter((step) => step.skipped === true && reasons.has(step.name))
          .filter((step) => skipWhy(floor, step.name) === undefined)
          .map((step) => step.name);
  return { reasons: Object.fromEntries(reasons), unwaived };
}
