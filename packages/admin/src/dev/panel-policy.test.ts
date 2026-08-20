// The permission matrix: "can this actor do that, and why?". Two things it must get right — the
// cell for a pair the authz never answered is DENY, not blank, and `unreachable` names a
// permission nobody holds, which is what a policy with an impossible rule looks like from outside.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { PolicyFact } from './facts';
import { policyPanel } from './panel-policy';

const fact = (
  over: Partial<PolicyFact> & Pick<PolicyFact, 'permission' | 'actorId'>,
): PolicyFact => ({
  allowed: false,
  trace: [],
  ...over,
});

/** Deliberately unsorted and gappy: `u_2` never answers for `post:publish` at all. */
const FACTS: readonly PolicyFact[] = [
  fact({ permission: 'post:read', actorId: 'u_2', allowed: true, trace: ['role reader'] }),
  fact({ permission: 'post:publish', actorId: 'u_1', allowed: true, trace: ['role editor'] }),
  fact({ permission: 'post:read', actorId: 'u_1', allowed: true }),
  fact({ permission: 'post:purge', actorId: 'u_1', allowed: false, trace: ['no rule matched'] }),
  fact({ permission: 'post:purge', actorId: 'u_2', allowed: false }),
];

const data = (params = ''): ReturnType<typeof policyPanel.data> =>
  policyPanel.data(
    staticDevSources({ policyMatrix: () => Promise.resolve(FACTS) }),
    new URLSearchParams(params),
  );

describe('the axes are the distinct actors and permissions, sorted', () => {
  test('each name appears once, in an order that does not depend on fact order', async () => {
    const panel = await data();
    expect(panel.actors).toEqual(['u_1', 'u_2']);
    expect(panel.permissions).toEqual(['post:publish', 'post:purge', 'post:read']);
  });
});

describe('a cell nobody answered for is deny, never blank', () => {
  test('every actor gets a boolean on every row', async () => {
    const panel = await data();
    const publish = panel.matrix.find((row) => row.permission === 'post:publish');
    expect(publish).toBeDefined();
    if (publish === undefined) return;

    expect(publish.byActor['u_1']).toBe(true);
    // There is no `post:publish` fact for `u_2` at all. `undefined` here renders as an empty
    // cell, which reads as "unknown" — the one thing an authz matrix may never say.
    expect(publish.byActor['u_2']).toBe(false);
    expect(Object.keys(publish.byActor)).toEqual(['u_1', 'u_2']);
  });

  test('the whole matrix is rectangular: one cell per actor on every row', async () => {
    const panel = await data();
    for (const row of panel.matrix) {
      expect(Object.keys(row.byActor)).toEqual([...panel.actors]);
      expect(Object.values(row.byActor).every((cell) => typeof cell === 'boolean')).toBe(true);
    }
  });
});

describe('unreachable permissions', () => {
  test('a permission no actor holds is named; one somebody holds is not', async () => {
    const panel = await data();
    // `post:purge` is denied for both actors — usually a rule nobody can satisfy.
    expect(panel.unreachable).toEqual(['post:purge']);
  });

  test('an empty matrix has no unreachable rows to report', async () => {
    const panel = await policyPanel.data(staticDevSources(), new URLSearchParams());
    expect(panel.actors).toEqual([]);
    expect(panel.permissions).toEqual([]);
    expect(panel.matrix).toEqual([]);
    expect(panel.unreachable).toEqual([]);
  });
});

describe('the selected cell carries the trace that produced it', () => {
  test('?permission=&actor= selects exactly one cell', async () => {
    const panel = await data('permission=post:publish&actor=u_1');
    expect(panel.trace).toEqual(['role editor']);
  });

  test('a denial’s trace is shown too — "why not" is the panel’s whole question', async () => {
    const panel = await data('permission=post:purge&actor=u_1');
    expect(panel.trace).toEqual(['no rule matched']);
  });

  test('half a selection selects nothing rather than the first fact that matches one axis', async () => {
    // Matching on the permission alone would show `u_1`'s trace while the reader had asked
    // about `u_2` — a trace attributed to the wrong actor is worse than none.
    expect((await data('permission=post:publish')).trace).toEqual([]);
    expect((await data('actor=u_1')).trace).toEqual([]);
    expect((await data()).trace).toEqual([]);
  });

  test('the raw facts are carried through unchanged, for the panel to render beneath', async () => {
    expect((await data()).facts).toEqual(FACTS);
  });
});
