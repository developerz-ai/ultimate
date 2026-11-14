// The `global` verdict: a read whose control touched only entities declared `entity({ global })`
// has no row of A's to hand back, so it is `global` with the reasons, never `unproven`. One entity
// that is not global, or one statement no repository attributed, keeps today's `unproven`. The
// write half stands: a global read that moved A's row is crossed.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from './exercise-report';
import type { SeedRow } from './seed-graph-plan';
import type { TenantTaint } from './tenant-canary';
import type { TenantAttack } from './tenant-proof';
import { globalEntities, globalReason, proveTenant, readsOf } from './tenant-proof';
import { testName } from './test-types';

const POST = 'bbbbbbbb-0000-7000-8000-000000000001';
const rows: readonly SeedRow[] = [
  { entity: 'posts', table: 'posts', tenant: 'a', row: { id: POST, title: 'title-c0ffee0002' } },
];
const taint: TenantTaint = { tenant: 'a', rows, ids: [POST], marks: [POST, 'c0ffee0002'] };
const reached: ExerciseRecord = {
  kind: 'query',
  name: 'planCatalog',
  outcome: 'reached',
  statements: 1,
  effects: [],
  ms: 0,
};
const globals = new Map([['plans', 'the plan catalog every org reads']]);

function plan(reads: readonly string[] | null, moves = false): TenantAttack {
  const digests: (string | null)[] = ['p0'];
  return {
    taint,
    input: {},
    public: undefined,
    read: true,
    sweep: false,
    tenantless: false,
    globals,
    attack: async () => {
      if (moves) digests[0] = 'moved';
      return { output: [{ code: 'pro' }], payloads: [] };
    },
    control: async () => ({ record: reached, output: [{ code: 'pro' }], reads }),
    snapshot: async () => [...digests],
  };
}

describe(testName('unit', 'tenant proof: a read over global entities'), () => {
  test('every entity the control read is global: the verdict is global, with the reason', async () => {
    const proof = (await proveTenant(plan(['plans']))).tenant;
    expect(proof?.verdict).toBe('global');
    expect(proof !== undefined && 'reason' in proof ? proof.reason : '').toContain(
      'plans: the plan catalog every org reads',
    );
  });

  test('one entity that is not global keeps the read unproven', async () => {
    expect((await proveTenant(plan(['plans', 'members']))).tenant?.verdict).toBe('unproven');
  });

  test('a statement no repository attributed keeps the read unproven', async () => {
    expect((await proveTenant(plan(null))).tenant?.verdict).toBe('unproven');
  });

  test('a read that touched nothing has nothing global to declare: unproven', async () => {
    expect((await proveTenant(plan([]))).tenant?.verdict).toBe('unproven');
  });

  test('the write half is kept: a global read that moved A’s row is crossed', async () => {
    expect((await proveTenant(plan(['plans'], true))).tenant?.verdict).toBe('crossed');
  });

  test('an action is never judged global: only a read has rows of A’s to miss', async () => {
    const action = { ...plan(['plans']), read: false };
    expect((await proveTenant(action)).tenant).toEqual({ verdict: 'proven' });
  });
});

describe(testName('unit', 'tenant proof: what the control read'), () => {
  const seg = (reads: readonly string[] | null | undefined) => ({ reads });

  test('the union of every call’s entities, in order', () => {
    expect(readsOf([seg(['plans']), seg(['prices', 'plans'])])).toEqual(['plans', 'prices']);
  });

  test('one call with an unattributed statement makes the whole read unknown', () => {
    expect(readsOf([seg(['plans']), seg(null)])).toBeNull();
    expect(readsOf([seg(['plans']), seg(undefined)])).toBeNull();
  });

  test('globalReason names each entity and its reason; any other entity answers none', () => {
    expect(globalReason(['plans'], globals)).toContain('plans: the plan catalog every org reads');
    expect(globalReason(['plans', 'posts'], globals)).toBeUndefined();
    expect(globalReason(undefined, globals)).toBeUndefined();
    expect(globalReason(['plans'], undefined)).toBeUndefined();
  });

  test('globalEntities reads each description’s global reason, and skips the rest', () => {
    const fake = (name: string, global?: string) => ({
      $name: name,
      $describe: () => (global === undefined ? {} : { global }),
    });
    expect([...globalEntities([fake('plans', 'catalog'), fake('posts')])]).toEqual([
      ['plans', 'catalog'],
    ]);
  });
});
