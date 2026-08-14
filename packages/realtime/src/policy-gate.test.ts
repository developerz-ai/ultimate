// The regression fence for the row gate. The row a subscriber is being judged on reaches the
// predicate as `args.row` — the same field an HTTP or job rule reads — and is no longer nested
// inside `args.input`. A denied row is still dropped rather than raised.

import { describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import { isRow, type Row } from './json';
import { authorizeWithPolicy, visibleWithPolicy } from './policy-gate';

/** What the gate hands the policy. Asserting on it is the whole point of this file. */
interface SeenArgs {
  readonly input: unknown;
  readonly actor: unknown;
  readonly row: unknown;
}

const ALLOWED = { allowed: true } as const;
const DENIED = { allowed: false, reason: 'row:read denied', code: 'X_FORBIDDEN' } as const;

/**
 * A structural stand-in for a `Policy`. Realtime reaches authz only through `@ultimat3/query`'s
 * `guard`, so this records the args rather than importing the policy package and opening the
 * second seam this file exists to prevent.
 */
function spyPolicy(seen: SeenArgs[], decide: (args: SeenArgs) => boolean) {
  return {
    kind: 'permission' as const,
    label: 'row:read',
    permissions: [],
    children: [],
    run(args: SeenArgs) {
      seen.push(args);
      return decide(args) ? ALLOWED : DENIED;
    },
  };
}

const options = () => ({ query: 'posts.feed', ctx: createContext() });
const row: Row = { id: 'row-42', authorId: 'owner' };
const input = { orgId: 'org-1' };

describe('visibleWithPolicy', () => {
  test('hands the predicate the row as a first-class field', async () => {
    const seen: SeenArgs[] = [];
    const visible = visibleWithPolicy(
      spyPolicy(seen, () => true),
      options(),
    );

    await expect(visible({ actor: null, row, input })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.row).toEqual(row);
    expect(seen[0]?.input).toEqual(input);
  });

  test('a rule written as ({ row }) => row.id decides the row it was given', async () => {
    const seen: SeenArgs[] = [];
    const isRow42 = (args: SeenArgs): boolean => isRow(args.row) && args.row.id === 'row-42';
    const visible = visibleWithPolicy(spyPolicy(seen, isRow42), options());

    await expect(visible({ actor: null, row, input })).resolves.toBe(true);
    await expect(visible({ actor: null, row: { id: 'row-7' }, input })).resolves.toBe(false);
  });

  test('a rule reading the old `input.row` no longer sees the row', async () => {
    const seen: SeenArgs[] = [];
    // This predicate passed before the shapes were unified, because the gate nested the row
    // inside the policy input. It must not pass now: `input` carries the query input only.
    const readsOldShape = (args: SeenArgs): boolean =>
      typeof args.input === 'object' && args.input !== null && 'row' in args.input;
    const visible = visibleWithPolicy(spyPolicy(seen, readsOldShape), options());

    await expect(visible({ actor: null, row, input })).resolves.toBe(false);
    expect(seen[0]?.input).not.toHaveProperty('row');
    expect(seen[0]?.input).not.toHaveProperty('input');
  });

  test('a denied row is dropped, never raised to the caller', async () => {
    const visible = visibleWithPolicy(
      spyPolicy([], () => false),
      options(),
    );
    await expect(visible({ actor: null, row, input })).resolves.toBe(false);
  });

  test('a rule that throws is a failure, not a denial — it reaches the caller', async () => {
    // The bug this pins: a bare `catch { return false }` read a dead database as "you may not see
    // this row". The rows leave the screen, `live.rows_denied` counts the drop, and no error ever
    // reaches the node — an outage published as a permission change.
    const visible = visibleWithPolicy(
      {
        kind: 'permission' as const,
        label: 'row:read',
        permissions: [],
        children: [],
        run: () => {
          // A `TypeError` on purpose: what the gate must not do is read *any* non-denial as one,
          // and a framework error would leave "it matched a code" as an explanation for passing.
          throw new TypeError('connection pool exhausted');
        },
      },
      options(),
    );

    await expect(visible({ actor: null, row, input })).rejects.toThrow('connection pool exhausted');
  });
});

describe('authorizeWithPolicy', () => {
  test('says "no row here" with null rather than leaving the field absent', async () => {
    const seen: SeenArgs[] = [];
    const authorize = authorizeWithPolicy(
      spyPolicy(seen, () => true),
      options(),
    );

    await authorize({ actor: null, input });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.row).toBeNull();
    expect(seen[0]?.input).toEqual(input);
  });

  test('a denied subscribe throws — the socket must not open', async () => {
    const authorize = authorizeWithPolicy(
      spyPolicy([], () => false),
      options(),
    );
    await expect(authorize({ actor: null, input })).rejects.toThrow(/row:read denied/);
  });
});
