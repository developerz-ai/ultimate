// The tenant proof's legs with every seam faked: the order B, A, B with a snapshot around each B,
// a changed or deleted row of A's as a write crossing, a canary in an effect as a leak, an echo of
// B's own input as nothing, `public` skipping only the read half, and an unreached A unproven.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE as ENTITY_CROSS_TENANT_SCOPE } from '@ultimat3/entity';
import { allow, can } from '@ultimat3/policy';
import type { ExerciseRecord, TenantLeg } from './exercise-report';
import type { SeedRow } from './seed-graph-plan';
import type { TenantTaint } from './tenant-canary';
import type { LegAnswer, TenantAttack } from './tenant-proof';
import { CROSS_TENANT_SCOPE, proveTenant, publicReason, withoutCrossTenant } from './tenant-proof';
import { testName } from './test-types';

const POST = 'aaaaaaaa-0000-7000-8000-000000000001';
const FILE = 'aaaaaaaa-0000-7000-8000-000000000002';
const rows: readonly SeedRow[] = [
  { entity: 'posts', table: 'posts', tenant: 'a', row: { id: POST, title: 'title-c0ffee0001' } },
  { entity: 'files', table: 'files', tenant: 'a', row: { id: FILE } },
];
const taint: TenantTaint = {
  tenant: 'a',
  rows,
  ids: [POST, FILE],
  marks: [POST, FILE, 'c0ffee0001'],
};
const reached: ExerciseRecord = {
  kind: 'action',
  name: 'readPost',
  outcome: 'reached',
  statements: 1,
  effects: [],
  ms: 0,
};
const quiet: LegAnswer = { output: { ok: false }, payloads: [] };

/** A fake pass: `answers` per leg, `writes` applied to the digests during a leg. */
function harness(options: {
  readonly answers?: Partial<Record<TenantLeg, LegAnswer>>;
  readonly writes?: Partial<Record<TenantLeg, (digests: (string | null)[]) => void>>;
  readonly control?: ExerciseRecord;
  readonly public?: string;
  readonly read?: { readonly output: unknown };
}) {
  const calls: string[] = [];
  const digests: (string | null)[] = ['p0', 'f0'];
  const plan: TenantAttack = {
    taint,
    input: { postId: POST },
    public: options.public,
    read: options.read !== undefined,
    attack: async (leg) => {
      calls.push(`B:${leg}`);
      options.writes?.[leg]?.(digests);
      return options.answers?.[leg] ?? quiet;
    },
    control: async () => {
      calls.push('A');
      // A deletes its own post: never a crossing, it is A's row and A's call.
      digests[0] = null;
      return { record: options.control ?? reached, output: options.read?.output };
    },
    snapshot: async (asked) => {
      calls.push('snapshot');
      expect(asked).toBe(rows);
      return [...digests];
    },
  };
  return { plan, calls };
}

describe(testName('unit', 'tenant proof legs'), () => {
  test('B runs before A and again after, each B between two snapshots of A rows', async () => {
    const { plan, calls } = harness({});
    const record = await proveTenant(plan);
    expect(calls).toEqual([
      'snapshot',
      'B:before',
      'snapshot',
      'A',
      'snapshot',
      'B:after',
      'snapshot',
    ]);
    expect(record).toEqual({ ...reached, tenant: { verdict: 'proven' } });
  });

  test('a row of A changed or deleted during a B leg is a write crossing, by table and id', async () => {
    const { plan } = harness({
      writes: {
        before: (d) => {
          d[1] = 'f1';
        },
        after: (d) => {
          d[1] = null;
        },
      },
    });
    expect((await proveTenant(plan)).tenant).toEqual({
      verdict: 'crossed',
      findings: [
        { code: 'X_TENANT_WRITE_CROSSED', leg: 'before', table: 'files', id: FILE },
        { code: 'X_TENANT_WRITE_CROSSED', leg: 'after', table: 'files', id: FILE },
      ],
    });
  });

  test('a canary in an effect, or an id B was not handed, is a leak; an input echo is not', async () => {
    const { plan } = harness({
      answers: {
        before: { output: { id: POST }, payloads: [] },
        after: {
          output: { items: [{ id: FILE }] },
          payloads: [{ path: 'effect.mail[0]', value: { subject: 'title-c0ffee0001' } }],
        },
      },
    });
    expect((await proveTenant(plan)).tenant).toEqual({
      verdict: 'crossed',
      findings: [
        { code: 'X_TENANT_LEAK', leg: 'after', path: 'output.items[0].id' },
        { code: 'X_TENANT_LEAK', leg: 'after', path: 'effect.mail[0].subject' },
      ],
    });
  });

  test('public skips the read half only: a leak passes, a crossed write does not', async () => {
    const leaking = { output: { title: 'title-c0ffee0001' }, payloads: [] };
    const open = harness({ public: 'open', answers: { before: leaking } });
    expect((await proveTenant(open.plan)).tenant).toEqual({ verdict: 'public', reason: 'open' });
    const writing = harness({
      public: 'open',
      writes: {
        before: (d) => {
          d[0] = 'p1';
        },
      },
    });
    expect((await proveTenant(writing.plan)).tenant).toMatchObject({ verdict: 'crossed' });
  });

  test('an A that was not reached leaves the proof unproven, never proven', async () => {
    const { plan } = harness({ control: { ...reached, outcome: 'unreached', code: 'X_BOOM' } });
    expect((await proveTenant(plan)).tenant).toEqual({
      verdict: 'unproven',
      reason: expect.stringContaining('X_BOOM'),
    });
  });

  test('a read whose own A answer holds none of A rows is unproven: B empty proves nothing', async () => {
    // A cache shared across tenants: B filled it empty first, so A read the same nothing.
    const empty = harness({ read: { output: { items: [] } } });
    expect((await proveTenant(empty.plan)).tenant).toEqual({
      verdict: 'unproven',
      reason: expect.stringContaining("none of A's rows"),
    });
    // A's own id, handed to A, is A reading its row: proven.
    const own = harness({ read: { output: { items: [{ id: POST }] } } });
    expect((await proveTenant(own.plan)).tenant).toEqual({ verdict: 'proven' });
    // A public read is not held to it: its read half is not judged at all.
    const open = harness({ public: 'open', read: { output: null } });
    expect((await proveTenant(open.plan)).tenant).toEqual({ verdict: 'public', reason: 'open' });
  });

  test('a policy admitting anonymous is public; a permission or no policy is not', () => {
    expect(publicReason(allow())).toContain('anonymous');
    expect(publicReason(can('post:read'))).toBeUndefined();
    expect(publicReason(undefined)).toBeUndefined();
  });

  test('B never carries the cross-tenant capability; the scope is entity own', () => {
    expect(CROSS_TENANT_SCOPE).toBe(ENTITY_CROSS_TENANT_SCOPE);
    const admin = { ...userActor({ id: 'u', orgId: 'b' }), scopes: [CROSS_TENANT_SCOPE, 'x'] };
    expect(withoutCrossTenant(admin)?.scopes).toEqual(['x']);
    expect(withoutCrossTenant(null)).toBeNull();
  });
});
