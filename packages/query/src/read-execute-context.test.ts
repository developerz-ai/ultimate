// A source handed out by `sourceFor` is EXECUTED by its caller, later — and a `from()` source's
// rows (a tenant-scoped repository call) run only then. Built as an actor, it must execute as that
// actor: `exerciseQuery` executes outside the build's frame, and a repository call
// there met no actor at all (`X_TENANCY_UNSCOPED`) while the same call in an action was scoped.

import { afterEach, describe, expect, test } from 'bun:test';
import { tryUseContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { exerciseQuery } from './exercise';
import { query } from './query';
import { sourceFor } from './read';
import { resetQueries } from './registry';
import { from } from './source';

const caller = userActor({ id: 'u1', orgId: 'org-a' });

interface Row {
  readonly id: string;
  readonly seenBy: string;
}

/** The rows are produced at `execute()` — where a tenant-scoped repo derives its tenant. */
const observed: string[] = [];
const target = () =>
  query({
    input: t.object({ noop: t.boolean }),
    policy: allow('public'),
    sql: () =>
      from<Row>('posts', () => {
        const actor = tryUseContext()?.actor;
        const seenBy = actor === undefined ? 'NONE' : `${actor.id}@${actor.orgId ?? 'no-org'}`;
        observed.push(seenBy);
        return [{ id: '1', seenBy }];
      }).orderBy('id', 'asc'),
  }).named('observeExecuteIdentity');

afterEach(() => {
  observed.length = 0;
  resetQueries();
});

describe('a handed-out source executes as the actor it was built for', () => {
  test('execute() outside any context, and its seek and total too', async () => {
    const source = await sourceFor(target(), { noop: true }, { actor: caller });
    const seen = async (from: { execute(): Promise<readonly object[]> } | undefined) =>
      ((await from?.execute()) as readonly Row[] | undefined)?.map((row) => row.seenBy);
    expect(await seen(source)).toEqual(['u1@org-a']);
    expect(await seen(source.seek?.(null, 10))).toEqual(['u1@org-a']);
    expect(await seen(source.total?.())).toEqual(['u1@org-a']);
  });

  test('exerciseQuery reads as its declared actor', async () => {
    await exerciseQuery(target(), { actor: caller, runs: 2 });
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set(['u1@org-a']));
  });
});
