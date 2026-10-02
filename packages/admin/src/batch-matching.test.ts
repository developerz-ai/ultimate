// `matching` on a batch action: "all matching" as ONE set-based call over the list's own `where` —
// row scope, scope and filters — answering `{ affected, remaining }`, gated once, audited once, and
// never reached by a checked selection, which still runs row by row through the button's gate.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { staticAuthz } from './authz';
import type { AdminAction, AdminFilter } from './registry';

const { defineAdmin } = await import('./admin');
const { runAdminBatch } = await import('./batch');

const parcels = entity('admin_match_parcels', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), state: text({ max: 16 }) },
});
const db = database({ parcels }, { driver: memoryDriver() });

const calls: { where: readonly AdminFilter[]; input: unknown }[] = [];
const perRow: string[] = [];

const ship: AdminAction = {
  name: 'parcel.ship',
  permission: 'admin_match_parcels:ship',
  entity: 'admin_match_parcels',
  batch: true,
  handle: async ({ input }) => {
    perRow.push(String(input['id']));
  },
  matching: async ({ where, input }) => {
    calls.push({ where, input });
    return { affected: 7, remaining: 3 };
  },
};
const drop: AdminAction = {
  name: 'parcel.drop',
  permission: 'admin_match_parcels:drop',
  entity: 'admin_match_parcels',
  destructive: true,
  batch: true,
  handle: async () => {},
  matching: async () => ({ affected: 2, remaining: 0 }),
};

const admin = defineAdmin({
  basePath: '/match',
  entities: [parcels],
  db,
  actions: [ship, drop],
  resources: {
    admin_match_parcels: {
      scopes: { open: { where: [{ field: 'state', op: 'eq', value: 'open' }] } },
      rows: (actor) =>
        actor.orgId === undefined ? [] : [{ field: 'title', op: 'eq', value: actor.orgId }],
    },
  },
  auth: {
    authz: staticAuthz([
      'admin:destroy',
      'admin_match_parcels:read',
      'admin_match_parcels:ship',
      'admin_match_parcels:drop',
    ]),
  },
});
const resource = admin.resource('admin_match_parcels');
const ctx = (orgId?: string) =>
  admin.ctx({ actor: { id: 'u', ...(orgId === undefined ? {} : { orgId }) }, requestId: 'm' });

afterAll(() => clearRegistry());

describe('unit · a set-based "all matching"', () => {
  test('is ONE call over row scope, scope and filters, answering affected and remaining', async () => {
    calls.length = 0;
    perRow.length = 0;
    const result = await runAdminBatch({
      resource,
      action: ship,
      ctx: ctx('org-a'),
      selection: {
        kind: 'all',
        request: { scope: 'open', filters: [{ field: 'title', op: 'contains', value: 'x' }] },
      },
    });
    if (!result.ok) return expect.unreachable(`refused: ${result.kind}`);
    expect({ done: result.done, remaining: result.remaining, after: result.after }).toEqual({
      done: 7,
      remaining: 3,
      after: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.where).toEqual([
      { field: 'title', op: 'eq', value: 'org-a' },
      { field: 'state', op: 'eq', value: 'open' },
      { field: 'title', op: 'contains', value: 'x' },
    ]);
    expect(perRow).toEqual([]);
  });

  test('is gated once and audited once; a checked selection never reaches it', async () => {
    calls.length = 0;
    const refusing = { ...ctx(), authz: staticAuthz(['admin:write', 'admin_match_parcels:read']) };
    const denied = await runAdminBatch({
      resource,
      action: ship,
      ctx: refusing,
      selection: { kind: 'all', request: {} },
    });
    expect(denied.ok).toBe(false);
    expect(calls).toEqual([]);

    const log = ctx();
    const shipped = async () =>
      (await log.audit.entries({ entity: 'admin_match_parcels' })).filter(
        (entry) => entry.operation === 'parcel.ship',
      );
    const before = (await shipped()).length;
    await runAdminBatch({
      resource,
      action: ship,
      ctx: log,
      selection: { kind: 'all', request: {} },
    });
    const mine = await shipped();
    expect(mine.length - before).toBe(1);
    expect(mine[0]?.reason).toBe('admin.batch.matching');

    const row = await db.parcels.insert({ title: 't', state: 'open' });
    const checked = await runAdminBatch({
      resource,
      action: ship,
      ctx: ctx(),
      selection: { kind: 'ids', ids: [String(row.id)] },
    });
    expect(checked.ok && checked.done).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('a destructive one asks for "all matching" to be typed, then runs', async () => {
    const first = await runAdminBatch({
      resource,
      action: drop,
      ctx: ctx(),
      selection: { kind: 'all', request: {} },
    });
    if (first.ok || first.kind !== 'confirm') return expect.unreachable('ran unconfirmed');
    expect(first.token).toBe('admin_match_parcels:all matching');
    expect(first.count).toBeNull();
    const second = await runAdminBatch({
      resource,
      action: drop,
      ctx: ctx(),
      selection: { kind: 'all', request: {} },
      confirmation: first.token,
    });
    expect(second.ok && second.done).toBe(2);
  });

  test('`matching` on an action that is not a batch action is refused at defineAdmin', () => {
    expect(() =>
      defineAdmin({
        basePath: '/match-bad',
        entities: [parcels],
        db,
        actions: [
          {
            name: 'parcel.lone',
            permission: 'admin_match_parcels:ship',
            entity: 'admin_match_parcels',
            handle: async () => {},
            matching: async () => ({ affected: 0, remaining: 0 }),
          },
        ],
      }),
    ).toThrow(/matching.*batch/);
  });
});
