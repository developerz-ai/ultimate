// The read half of `@ultimat3/action`'s `invoke-context.test.ts`, and the twin it must stay equal
// to: `asActor` honoured an explicit `ctx` as a PARAMETER and never installed it, so `guard()`
// decided about that actor while `sql()` — and every tenant-scoped repository call one frame
// deeper, which derives from `tryUseContext()` — saw a different identity, or none at all.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { createContext, runWithContext, tryUseContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { runQuery, sourceFor } from './read';
import { resetRegistry } from './registry';
import { from } from './source';

const ORG = 'org-a';
const caller: Actor = { ...userActor({ id: 'u1', orgId: ORG }), permissions: ['post:read'] };

interface Row {
  readonly id: string;
  readonly seenBy: string;
}

const label = (actor: Actor | null | undefined): string =>
  actor === null || actor === undefined ? 'NONE' : `${actor.id}@${actor.orgId ?? 'no-org'}`;

/** `policyActor` is what `guard()` saw; the row carries what the AMBIENT context carried. */
const build = () => {
  let policyActor = 'never evaluated';
  const target = query({
    input: t.object({ noop: t.boolean }),
    policy: can('post:read', ({ actor }) => {
      policyActor = label(actor);
      return true;
    }),
    // Read where `sql()` runs — the frame a repository chain is BUILT in, and the frame whose
    // ambient actor `scopedPlan` takes the tenant from. Deliberately `tryUseContext()` and not the
    // `ctx` argument: the argument was never the thing that was missing.
    sql: () => {
      const seenBy = label(tryUseContext()?.actor);
      return from<Row>('posts', () => [{ id: '1', seenBy }]).orderBy('id', 'asc');
    },
  }).named('observeReadIdentity');
  return { target, seenByPolicy: (): string => policyActor };
};

afterEach(() => {
  resetRegistry();
});

describe('an explicit ctx is INSTALLED on the read path too', () => {
  test('the three spellings of one caller agree, policy and ambient alike', async () => {
    const { target, seenByPolicy } = build();

    const ambient = await runWithContext(createContext({ actor: caller }), () =>
      runQuery(target, { noop: true }),
    );
    const ambientPolicy = seenByPolicy();
    const byActor = await runQuery(target, { noop: true }, { actor: caller });
    const byActorPolicy = seenByPolicy();
    const byCtx = await runQuery(
      target,
      { noop: true },
      { ctx: createContext({ actor: caller }), fresh: true },
    );
    const byCtxPolicy = seenByPolicy();

    expect(ambientPolicy).toBe(`u1@${ORG}`);
    expect(byActorPolicy).toBe(ambientPolicy);
    expect(byCtxPolicy).toBe(ambientPolicy);

    // The half that was missing: the rows were built under a context nobody had installed.
    expect((ambient[0] as Row).seenBy).toBe(`u1@${ORG}`);
    expect((byActor[0] as Row).seenBy).toBe((ambient[0] as Row).seenBy);
    expect((byCtx[0] as Row).seenBy).toBe((ambient[0] as Row).seenBy);
  });

  test('sourceFor installs it as well — every projection builds on that one path', async () => {
    const { target } = build();
    const source = await sourceFor(
      target,
      { noop: true },
      { ctx: createContext({ actor: caller }) },
    );
    const rows = await source.execute();

    expect((rows[0] as Row).seenBy).toBe(`u1@${ORG}`);
  });
});
