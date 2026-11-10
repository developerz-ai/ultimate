// A declared actor is re-homed whole: its `orgId` AND every fact naming the org it was declared in
// (a string, or an array holding it) become the primitive's tenant — symmetric with the input's
// re-homed `orgId`, so a membership-fact policy can pass in every tenant the pass seeds.

import { describe, expect, test } from 'bun:test';
import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import type { Actor, ActorFactMap } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import { can, definePermissions } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import { inTenant } from './exercise-actor';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

definePermissions(['eaf:write']);

const DECLARED = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

/** The app's own fact, declared by module augmentation in an app; read untyped here. */
const memberOrgIds = (actor: Actor | null): readonly unknown[] => {
  const facts: Readonly<Record<string, unknown>> = actor?.facts ?? {};
  const value = facts['memberOrgIds'];
  return Array.isArray(value) ? value : [];
};

const member = (facts: Readonly<Record<string, unknown>>): Actor => {
  const map: ActorFactMap = facts;
  return {
    ...userActor({ id: 'member', orgId: DECLARED, permissions: ['eaf:write'] }),
    facts: map,
  };
};

const writer: SeedWriter = {
  insert: async () => undefined,
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

registerActions({
  eafPost: action({
    input: t.object({ orgId: t.uuid }),
    output: t.object({ ok: t.boolean }),
    policy: can<{ readonly orgId?: string }>('eaf:write', ({ actor, input }) =>
      memberOrgIds(actor).includes(input.orgId),
    ),
    handle: () => ({ ok: true }),
  }),
});

describe(testName('unit', 'inTenant · facts'), () => {
  test('a fact equal to the declared org, alone or in an array, is the tenant; others stay', () => {
    const moved = inTenant(
      member({ memberOrgIds: [DECLARED, OTHER], homeOrg: DECLARED, tz: 'UTC' }),
      't1',
    );
    expect(moved?.orgId).toBe('t1');
    const facts: Readonly<Record<string, unknown>> | undefined = moved?.facts;
    expect(facts).toEqual({ memberOrgIds: ['t1', OTHER], homeOrg: 't1', tz: 'UTC' });
  });

  test('an actor with no facts gains none', () => {
    const bare = userActor({ id: 'bare', orgId: DECLARED });
    expect(inTenant(bare, 't1')).toEqual({ ...bare, orgId: 't1' });
  });
});

describe(testName('unit', 'runExercisePass · a membership-fact policy'), () => {
  test('the declared org in the input and in the fact are re-homed together: reached', async () => {
    const records = await runExercisePass({
      entities: [],
      writer,
      roles: () => [{ name: 'anonymous', actor: null }],
      only: 'eafPost',
      overrides: defineExercise({
        eafPost: {
          actor: member({ memberOrgIds: [DECLARED] }),
          input: (drawn) => ({ ...drawn, orgId: DECLARED }),
        },
      }),
    });
    expect((records[0] as ExerciseRecord).outcome).toBe('reached');
  });
});
