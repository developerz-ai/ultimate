// The version checks can fail: a store whose own `update` ignores `advance`, and whose `upsert`
// keeps the incoming stamp — the clock's, one millisecond equal to the stored — fails both
// checks; the same store applying `advanceVersion` passes them.

import { describe, expect, test } from 'bun:test';
import type { EntityCore } from '@ultimat3/entity';
import type { DriverRepo, UpsertPlan } from '@ultimat3/entity/adapter';
import { advanceVersion, defineDriver, selectRows } from '@ultimat3/entity/adapter';
import { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
import type { EntityDriverSubject } from './entity-driver-conformance';
import { runEntityDriverCheck } from './entity-driver-conformance';
import { testName } from './test-types';

/** A Map per table with its own `upsert`; `advance` says whether the merge applies the rule. */
const upsertingStore = (advance: boolean): EntityDriverSubject => ({
  capabilities: ['upsert'],
  foreignKeys: false,
  open: () =>
    defineDriver({
      name: advance ? 'advancing' : 'stale',
      capabilities: ['upsert'],
      repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
        const rows: Row[] = [];
        const field = (row: Row, key: string) => (row as Record<string, unknown>)[key];
        const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']) =>
          selectRows(table, rows, { plan, after: undefined, limit: rows.length });
        return {
          select: async (read) => selectRows(table, rows, read),
          count: async ({ plan }) => matched(plan).length,
          insert: async (batch) => {
            rows.push(...batch);
            return batch;
          },
          update: async ({ plan }, patch, rule) => {
            const hit = matched(plan);
            for (const row of hit) {
              const next = { ...row, ...patch } as Row;
              rows[rows.indexOf(row)] =
                advance && rule !== undefined
                  ? advanceVersion(table, row, next, (key) => key === rule.property)
                  : next;
            }
            return hit.length;
          },
          delete: async ({ plan }) => {
            const hit = matched(plan);
            for (const row of hit) rows.splice(rows.indexOf(row), 1);
            return hit.length;
          },
          upsert: async (batch, plan: UpsertPlan) =>
            batch.map((row) => {
              const at = rows.findIndex((stored) =>
                plan.on.every((key) => field(stored, key) === field(row, key)),
              );
              const stored = rows[at];
              if (stored === undefined) {
                rows.push(row);
                return row;
              }
              const taken = Object.fromEntries(plan.set.map((key) => [key, field(row, key)]));
              const plain = { ...stored, ...taken } as Row;
              const merged = advance
                ? advanceVersion(table, stored, plain, (key) => plan.set.includes(key))
                : plain;
              rows[at] = merged;
              return merged;
            }),
        };
      },
    }),
});

const checkNamed = (prefix: string) => {
  const check = ENTITY_DRIVER_CHECKS.find((each) => each.name.startsWith(prefix));
  if (check === undefined) return expect.unreachable(`no version check named ${prefix}`);
  return check;
};
const upsertCheck = () => checkNamed("a searchable entity's upsert collision");
const updateCheck = () => checkNamed("a searchable entity's update in the same ms");

describe(testName('unit', "a store's own update, upsert and the version rule"), () => {
  test('a store keeping the stamp it was handed fails the upsert version check', async () => {
    await expect(runEntityDriverCheck(upsertCheck(), upsertingStore(false))).rejects.toThrow();
  });

  test('a store whose update ignores advance fails the update version check', async () => {
    await expect(runEntityDriverCheck(updateCheck(), upsertingStore(false))).rejects.toThrow();
  });

  test('the same store applying advanceVersion passes both', async () => {
    await runEntityDriverCheck(upsertCheck(), upsertingStore(true));
    await runEntityDriverCheck(updateCheck(), upsertingStore(true));
  });
});
