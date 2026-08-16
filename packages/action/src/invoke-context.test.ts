// One action, three ways of naming who is calling — the ambient context, `options.actor`,
// `options.ctx` — and one identity behind all three. `options.ctx` used to be honoured as a
// PARAMETER and never installed, so `guard()` decided about that actor while everything reading
// `tryUseContext()` (most of all `@ultimat3/entity`'s tenant guard, which derives from it rather
// than from the ctx it is handed) saw a different identity, or none.
//
// The assertion is written as an equality BETWEEN the spellings, never as three independent
// expectations: a fix that reopens the gap on one of them has to fail here.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { createContext, runWithContext, tryUseContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { invoke } from './invoke';
import { resetRegistry } from './registry';

const Input = t.object({ noop: t.boolean });
const Output = t.object({ policyActor: t.string, ambientActor: t.string });

const ORG = 'org-a';
const caller: Actor = { ...userActor({ id: 'u1', orgId: ORG }), permissions: ['post:publish'] };

/** What one invocation observed, from the two places identity is read. */
interface Seen {
  readonly policyActor: string;
  readonly ambientActor: string;
}

const label = (actor: Actor | null | undefined): string =>
  actor === null || actor === undefined ? 'NONE' : `${actor.id}@${actor.orgId ?? 'no-org'}`;

const build = () => {
  let policyActor = 'never evaluated';
  const target = action({
    input: Input,
    output: Output,
    // The predicate runs inside `guard()`, which is the one authz evaluation.
    policy: can('post:publish', ({ actor }) => {
      policyActor = label(actor);
      return true;
    }),
    // The ambient read is deliberately `tryUseContext()` and not the handler's own `ctx`: that is
    // the exact read every tenant-scoped repository operation makes one frame deeper.
    handle: (): Seen => ({ policyActor, ambientActor: label(tryUseContext()?.actor) }),
  }).named('observeIdentity');
  return target;
};

afterEach(() => {
  resetRegistry();
});

describe('an explicit ctx is INSTALLED, not merely passed', () => {
  test('the three spellings of one caller agree on the identity, policy and ambient alike', async () => {
    const target = build();

    const ambient = (await runWithContext(createContext({ actor: caller }), () =>
      invoke(target, { noop: true }),
    )) as Seen;
    const byActor = (await invoke(target, { noop: true }, { actor: caller })) as Seen;
    const byCtx = (await invoke(
      target,
      { noop: true },
      { ctx: createContext({ actor: caller }) },
    )) as Seen;

    // Every surface's policy saw the same caller — this half already held.
    expect(ambient.policyActor).toBe(`u1@${ORG}`);
    expect(byActor.policyActor).toBe(ambient.policyActor);
    expect(byCtx.policyActor).toBe(ambient.policyActor);

    // And so did every surface's AMBIENT context — this half is the fix. `byCtx.ambientActor` was
    // `NONE`, which is what let a tenant-scoped write inside the handler name any org it liked.
    expect(ambient.ambientActor).toBe(`u1@${ORG}`);
    expect(byActor.ambientActor).toBe(ambient.ambientActor);
    expect(byCtx.ambientActor).toBe(ambient.ambientActor);
  });

  test('an explicit ctx installed under an ambient one wins, and does not leak past the call', async () => {
    const target = build();
    const other: Actor = {
      ...userActor({ id: 'u2', orgId: 'org-b' }),
      permissions: ['post:publish'],
    };

    const outcome = await runWithContext(createContext({ actor: caller }), async () => {
      const inner = (await invoke(
        target,
        { noop: true },
        { ctx: createContext({ actor: other }) },
      )) as Seen;
      return { inner, after: label(tryUseContext()?.actor) };
    });

    expect(outcome.inner.ambientActor).toBe('u2@org-b');
    expect(outcome.inner.policyActor).toBe(outcome.inner.ambientActor);
    expect(outcome.after).toBe(`u1@${ORG}`);
  });
});
