// A `shared` parent under a tenant child's UNIQUE foreign key: each tenant's children take parent
// rows no other tenant may reuse, so the parent table must hold a row for every tenant's children
// — `perTable` alone ran it out before tenant 2 (`X_SEED_GRAPH_UNSATISFIED`).

import { describe, expect, test } from 'bun:test';
import { entity, invariant, text, uuid } from '@ultimat3/entity';
import { seedGraph } from './seed-graph';
import { testName } from './test-types';

const orgs = entity('sgs_orgs', { columns: { id: uuid().primaryKey() } });
const requests = entity('sgs_approval_requests', {
  columns: { id: uuid().primaryKey(), note: text() },
  shared: 'an approval request is reviewed across every org',
});
const refunds = entity('sgs_refunds', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    approvalRequestId: uuid()
      .references(() => requests.id)
      .unique(),
  },
});

const of = (graph: ReturnType<typeof seedGraph>, name: string) =>
  graph.inserts.filter((row) => row.entity === name);

describe(testName('unit', 'seedGraph · a shared parent under a unique key'), () => {
  test('every tenant seeds its unique children, each on a parent row of its own', () => {
    const graph = seedGraph({ orgs, requests, refunds }, { tenants: 2, perTable: 3 });
    const children = of(graph, 'sgs_refunds');
    expect(children).toHaveLength(6);
    expect(new Set(children.map((row) => row.tenant)).size).toBe(2);
    const keys = children.map((row) => row.row['approvalRequestId']);
    expect(new Set(keys).size).toBe(keys.length);
    // The parent stays shared: no tenant, and one table-wide set of rows.
    expect(of(graph, 'sgs_approval_requests').every((row) => row.tenant === null)).toBe(true);
  });

  test('scales with the tenant count, not past it', () => {
    const graph = seedGraph({ orgs, requests, refunds }, { tenants: 3, perTable: 2 });
    expect(of(graph, 'sgs_refunds')).toHaveLength(6);
    expect(of(graph, 'sgs_approval_requests')).toHaveLength(6);
  });

  test('a shared parent no unique key draws from keeps perTable rows', () => {
    const notes = entity('sgs_notes', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => orgs.id)
          .tenant(),
        approvalRequestId: uuid().references(() => requests.id),
      },
    });
    const graph = seedGraph({ orgs, requests, notes }, { tenants: 2, perTable: 3 });
    expect(of(graph, 'sgs_approval_requests')).toHaveLength(3);
    expect(of(graph, 'sgs_notes')).toHaveLength(6);
  });

  // Every tenant's child opens on the same rotation of the shared pool, so tenant k's row stepped
  // past the 3k parents earlier tenants took, building and judging each: quadratic in tenants —
  // an adopter's pass seed spent 98 s of 106 here at 1,188 tenants. The invariant is judged once
  // per row the solver builds, so it counts the tries: linear now, ~3·60²/2 = 5,400 before.
  test('a child row is judged a bounded number of times, however many tenants took parents first', () => {
    let judged = 0;
    const counted = entity('sgs_counted_refunds', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => orgs.id)
          .tenant(),
        approvalRequestId: uuid()
          .references(() => requests.id)
          .unique(),
      },
      invariants: (c) => [
        invariant(
          'sgs_counted',
          c.satisfies(() => {
            judged += 1;
            return true;
          }, ['approvalRequestId']),
        ),
      ],
    });
    const graph = seedGraph({ orgs, requests, counted }, { tenants: 60, perTable: 3 });
    const children = of(graph, 'sgs_counted_refunds');
    expect(children).toHaveLength(180);
    expect(new Set(children.map((row) => row.row['approvalRequestId'])).size).toBe(180);
    expect(judged).toBeLessThanOrEqual(children.length * 4);
    // A factory's `derive` may rewrite any column, so the rows are still built — but each one a
    // taken key refuses is refused before its rules are judged: still linear in what is judged.
    judged = 0;
    const factory = { build: () => ({}), reset: () => undefined, derive: () => ({}) };
    seedGraph(
      { orgs, requests, counted },
      { tenants: 60, perTable: 3, factories: { sgs_counted_refunds: factory } },
    );
    expect(judged).toBeLessThanOrEqual(children.length * 4);
  });

  test('a unique that includes the tenant column is per tenant: perTable parent rows serve all', () => {
    const links = entity('sgs_links', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => orgs.id)
          .tenant(),
        approvalRequestId: uuid().references(() => requests.id),
      },
      indexes: [{ on: ['orgId', 'approvalRequestId'], unique: true }],
    });
    const graph = seedGraph({ orgs, requests, links }, { tenants: 2, perTable: 3 });
    expect(of(graph, 'sgs_approval_requests')).toHaveLength(3);
    expect(of(graph, 'sgs_links')).toHaveLength(6);
  });
});
