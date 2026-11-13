// The scale sweep's sized seed is written beside the pass's graph: a factory value built from the
// row index on a unique column repeated the pass's own, the write died on the unique key and every
// primitive's scale proof was `unproven`. A writer that refuses a repeat stands in for Postgres.

import { describe, expect, test } from 'bun:test';
import { entity, text, uuid } from '@ultimat3/entity';
import type { ExerciseRoom } from './exercise-report';
import { defineFactory } from './factories';
import type { SentStatement } from './plan-sweep';
import { scaleSweep } from './scale-sweep-run';
import { seedGraph } from './seed-graph';
import type { SeedRow, SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('ssr_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const tokens = entity('ssr_tokens', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    code: text({ max: 40 }).unique(),
  },
});
const factories = {
  ssr_tokens: defineFactory<{ code: string }>(tokens, {
    defaults: (index) => ({ code: `c${index}` }),
  }),
};

/** Every row lands in one table set; a second `ssr_tokens.code` is refused, as its unique index does. */
const uniqueWriter = (): SeedWriter & { readonly codes: Set<unknown> } => {
  const codes = new Set<unknown>();
  const insert = async (row: SeedRow): Promise<void> => {
    if (row.entity !== 'ssr_tokens') return;
    const code = row.row['code'];
    if (codes.has(code)) {
      // Input to the sweep, as the driver's refusal is: never this test's verdict.
      const refusal = new TypeError(
        `duplicate key value violates unique constraint (code)=(${String(code)})`,
      );
      throw refusal;
    }
    codes.add(code);
  };
  return {
    codes,
    insert,
    update: async () => {},
    snapshot: async (rows) => rows.map(() => null),
  };
};

const quiet = { statements: 0, effects: [], refusedHosts: [], payloads: [], shapes: [] };
const quietRoom = (sent: ReadonlyMap<string, SentStatement> = new Map()): ExerciseRoom => ({
  observe: async (_subject, fn) => {
    try {
      return { observed: quiet, value: await fn() };
    } catch (error) {
      return { observed: quiet, error };
    }
  },
  owns: () => false,
  sent: () => sent,
  [Symbol.asyncDispose]: async () => {},
});

describe(testName('unit', 'scaleSweep'), () => {
  test("writes both sized graphs beside the pass's: no value built from a row index repeats", async () => {
    const writer = uniqueWriter();
    const main = seedGraph({ orgs, tokens }, { tenants: 4, seed: 7, factories });
    for (const row of main.inserts) await writer.insert(row);
    const proofs = await scaleSweep({
      subjects: [{ name: 'listTokens', call: async () => ({}) }],
      entities: [orgs, tokens],
      writer,
      main,
      seed: 7,
      room: quietRoom(),
      setup: async () => ({ actor: null, input: {} }),
      factories,
    });
    expect(proofs.get('listTokens')).toEqual({ verdict: 'flat', expected: [] });
    // The pass's rows, then 2 and 8 for the one sized tenant each.
    const passRows = main.inserts.filter((insert) => insert.entity === 'ssr_tokens').length;
    expect(writer.codes.size).toBe(passRows + 2 + 8);
  });

  test("one table's refusal is that table's: its readers unproven with it, the rest judged", async () => {
    const writer = uniqueWriter();
    const main = seedGraph({ orgs, tokens }, { tenants: 4, seed: 9, factories });
    for (const row of main.inserts) await writer.insert(row);
    // Every sized token collides with the pass's first one: the sized `ssr_tokens` cannot write.
    const collide: SeedWriter = {
      ...writer,
      insert: (row) =>
        writer.insert(
          row.entity === 'ssr_tokens' ? { ...row, row: { ...row.row, code: 'c0' } } : row,
        ),
    };
    const sent = new Map<string, SentStatement>([
      [
        'select "code" from "ssr_tokens" where "orgId" = $1',
        { primitives: new Set(['listTokens']) },
      ],
      ['select "name" from "ssr_orgs" where "id" = $1', { primitives: new Set(['getOrg']) }],
    ]);
    const proofs = await scaleSweep({
      subjects: [
        { name: 'listTokens', call: async () => ({}) },
        { name: 'getOrg', call: async () => ({}) },
      ],
      entities: [orgs, tokens],
      writer: collide,
      main,
      seed: 9,
      room: quietRoom(sent),
      setup: async () => ({ actor: null, input: {} }),
      factories,
    });
    expect(proofs.get('getOrg')).toEqual({ verdict: 'flat', expected: [] });
    const lost = proofs.get('listTokens');
    expect(lost?.verdict).toBe('unproven');
    expect(lost?.verdict === 'unproven' ? lost.seed?.entity : undefined).toBe('ssr_tokens');
    expect(lost?.verdict === 'unproven' ? lost.seed?.cause : '').toContain('unique constraint');
  });
});
