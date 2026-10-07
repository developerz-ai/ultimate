// Single responsibility: `t.array(items, { min, max })` — the list validator and its item-count
// bounds. Its own file because the bounds are a declaration-time refusal as well as a parse rule,
// and `validators.ts` was at the line ceiling.

import { type AnySchema, checkOf, fail, failWith, makeSchema, pass, type Schema } from './builder';
import { describeValue, expected } from './describe-value';
import { BoundsInvalidError } from './errors';
import type { SchemaNode } from './node';
import type { InferInput, InferOutput, StandardIssue } from './standard';

/**
 * Item-count bounds, inclusive. ON the array node, never an element rule or a `t.refine`: the node
 * is what OpenAPI, the MCP tool schema and the contract sampler read, so a bound kept anywhere
 * else is one every projection omits.
 */
export interface ArrayBounds {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

const items = (count: number): string => `${count} item${count === 1 ? '' : 's'}`;

/** A bound is a whole count from zero up — anything else matches no array, or every array. */
function boundFault(name: 'min' | 'max', bound: number | undefined): string | undefined {
  if (bound === undefined || (Number.isSafeInteger(bound) && bound >= 0)) return undefined;
  // `describeValue` for the shape, the value whole in `meta`: the house rule for a cause.
  return `t.array's ${name} must be a whole number from 0 up; got ${describeValue(bound)}`;
}

function assertBounds(bounds: ArrayBounds): void {
  const { min, max } = bounds;
  const fault =
    boundFault('min', min) ??
    boundFault('max', max) ??
    (min !== undefined && max !== undefined && min > max
      ? `t.array's min (${min}) is above its max (${max}), so no array satisfies it`
      : undefined);
  if (fault === undefined) return;
  throw new BoundsInvalidError({
    cause: fault,
    fix: 't.array(items, { min: 1, max: 20 })   # whole numbers, 0 <= min <= max; omit a bound to leave that side open',
    meta: { min, max },
  });
}

export function arraySchema<S extends AnySchema>(
  item: S,
  bounds: ArrayBounds = {},
): Schema<readonly InferInput<S>[], InferOutput<S>[]> {
  assertBounds(bounds);
  const { min, max } = bounds;
  const itemCheck = checkOf(item);
  const node: SchemaNode = {
    kind: 'array',
    items: item.node,
    ...(min === undefined ? {} : { minItems: min }),
    ...(max === undefined ? {} : { maxItems: max }),
  };
  return makeSchema<readonly InferInput<S>[], InferOutput<S>[]>(node, (value, path) => {
    if (!Array.isArray(value)) return fail(path, expected('an array', value));
    // The count before the items: an over-long array is refused without reading a member, so a
    // caller's 10,000-element body costs one comparison, not 10,000 item checks.
    if (min !== undefined && value.length < min) {
      return fail(path, expected(`an array of at least ${items(min)}`, value));
    }
    if (max !== undefined && value.length > max) {
      return fail(path, expected(`an array of at most ${items(max)}`, value));
    }
    const issues: StandardIssue[] = [];
    const out: unknown[] = [];
    for (const [index, member] of value.entries()) {
      const result = itemCheck(member, [...path, index]);
      if (result.ok) out.push(result.value);
      else issues.push(...result.issues);
    }
    if (issues.length > 0) return failWith(issues);
    return pass(out as InferOutput<S>[]);
  });
}
