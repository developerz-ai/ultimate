// Where a backfill's rows come from, and which ledger a pass writes: exactly one of `source` (a
// local chain) and `pages` (a remote page function), and — for a scoped declaration — the key
// `<name>:<scope(input)>` that both the ledger and the live idempotency key carry.

import type { Ctx, Environment } from '@ultimat3/core';
import { assert, describeValue } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { validate } from '@ultimat3/schema';
import type { BackfillBatch, BackfillPages } from './backfill-definition';
import { BackfillSourceInvalidError } from './backfill-errors';
import type { JobTenant } from './tenant';

/**
 * Every declaration shape as the pass reads it. Methods, so a typed declaration of either shape
 * is assignable without a cast per field.
 */
export interface AnyBackfill<Row> {
  readonly name: string;
  readonly tenant: JobTenant<never>;
  source?(args: { readonly ctx: Ctx }): ReadBuilder<Row>;
  readonly pages?: BackfillPages<Row, unknown> | undefined;
  handle(batch: BackfillBatch<Row, unknown>): Promise<void> | void;
  count?(args: { readonly ctx: Ctx; readonly input: unknown }): Promise<number> | number;
  readonly environments?: readonly Environment[] | undefined;
  scope?(input: unknown): string;
}

const invalid = (backfill: string, problem: string, fix: string): BackfillSourceInvalidError =>
  new BackfillSourceInvalidError({ backfill, problem, fix });

/** Refused where it was written: both or neither source, or an input no scope can key. */
export function assertBackfillSource(definition: {
  readonly name: string;
  readonly source?: unknown;
  readonly pages?: unknown;
  readonly input?: unknown;
  readonly scope?: unknown;
}): void {
  const name = definition.name;
  const hasSource = typeof definition.source === 'function';
  const hasPages = typeof definition.pages === 'function';
  if (hasSource === hasPages) {
    throw invalid(
      name,
      hasSource
        ? 'declares both source and pages, and a pass reads exactly one of them'
        : 'declares neither source nor pages, so it has no rows to visit',
      `pages: async ({ ctx, cursor, signal, input }) => ({ rows, next }) on backfill({ name: "${name}" }) — or source: ({ ctx }) => db.<table>.where(…) — never both`,
    );
  }
  if (definition.input !== undefined && typeof definition.scope !== 'function') {
    throw invalid(
      name,
      'declares an input and no scope, so every input would share one ledger row and one live pass',
      `scope: (input) => input.accountId beside input on backfill({ name: "${name}" })`,
    );
  }
}

/**
 * The ledger key and the live idempotency key. Unscoped it is the name — byte-identical to every
 * pass recorded before scopes existed. A scope is app data, so an empty one is refused rather than
 * colliding with the unscoped name.
 */
export function ledgerNameFor(
  name: string,
  scope: ((input: never) => string) | undefined,
  payload: { readonly input?: unknown },
): string {
  if (scope === undefined) return name;
  const key: unknown = (scope as (input: unknown) => unknown)(payload.input);
  assert(
    typeof key === 'string' && key.length > 0,
    `backfill "${name}" scope(input) answered ${describeValue(key)} — a scope is a non-empty string`,
    `scope: (input) => input.accountId on backfill({ name: "${name}" })`,
  );
  return `${name}:${key}`;
}

/** `{ force?, input }`, the input checked by the declaration's own schema, synchronously. */
export function scopedPayload<I>(
  name: string,
  input: StandardSchemaV1<unknown, I>,
): StandardSchemaV1<unknown, { readonly force?: boolean; readonly input: I }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-backfill',
      validate(value: unknown) {
        if (typeof value !== 'object' || value === null) {
          return { issues: [{ message: `backfill "${name}" payload must be { force?, input }` }] };
        }
        const raw = value as { readonly force?: unknown; readonly input?: unknown };
        if (raw.force !== undefined && typeof raw.force !== 'boolean') {
          return { issues: [{ message: 'force must be a boolean', path: ['force'] }] };
        }
        const parsed = validate(input, raw.input);
        if (parsed.issues !== undefined) {
          return {
            issues: parsed.issues.map((issue) => ({
              message: issue.message,
              path: ['input', ...(issue.path ?? [])],
            })),
          };
        }
        return {
          value: { ...(raw.force === undefined ? {} : { force: raw.force }), input: parsed.value },
        };
      },
    },
  };
}
