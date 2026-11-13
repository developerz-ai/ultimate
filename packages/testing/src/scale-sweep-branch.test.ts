// A data-dependent BRANCH is not a loop over rows: a primitive that sends one more statement when
// the row it was handed is `closed` must read `flat` whatever the seed, because the 8-row graph's
// first rows carry the 2-row graph's values. An adopter's job read 0 → 1 and was red.

import { describe, expect, test } from 'bun:test';
import { entity, enumerated, uuid } from '@ultimat3/entity';
import type { ExerciseRoom, Observed } from './exercise-report';
import type { ScaleSetup } from './scale-sweep-run';
import { scaleSweep } from './scale-sweep-run';
import { seedGraph } from './seed-graph';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('ssb_orgs', { columns: { id: uuid().primaryKey() } });
const signals = entity('ssb_signals', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    status: enumerated(['open', 'held', 'closed']),
  },
});

const writer: SeedWriter = {
  insert: async () => {},
  update: async () => {},
  snapshot: async (rows) => rows.map(() => null),
};

/** What the call under observation sent: set by the fixture primitive, read by the room. */
let sent: Observed['shapes'] = [];
const room: ExerciseRoom = {
  observe: async (_subject, fn) => {
    sent = [];
    const value = await fn();
    return {
      observed: { statements: 0, effects: [], refusedHosts: [], payloads: [], shapes: sent },
      value,
    };
  },
  owns: () => false,
  sent: () => new Map(),
  [Symbol.asyncDispose]: async () => {},
};

/** The tenant's first signal, as the pass binds an id field to the tenant's first seeded row. */
const setup: ScaleSetup = async (_subject, graph, tenant) => {
  const row = graph.inserts.find((one) => one.entity === 'ssb_signals' && one.tenant === tenant);
  return { actor: null, input: row?.row };
};

/** One read of the signal; a closed one also reads its events — once, never per row. */
const triage = {
  name: 'triageSignal',
  call: async (input: unknown) => {
    const status = (input as { status?: string } | undefined)?.status;
    sent = [
      { fingerprint: 'ssb_signals.findById', count: 1, unexpected: 1 },
      ...(status === 'closed'
        ? [{ fingerprint: 'ssb_events.findMany', count: 1, unexpected: 1 }]
        : []),
    ];
    return {};
  },
};

describe(testName('unit', 'scaleSweep · a branch on the seeded row'), () => {
  for (const tenants of [1, 2, 3, 4]) {
    for (const seed of [2, 5, 11]) {
      test(`is flat at both sizes (pass tenants ${tenants}, seed ${seed})`, async () => {
        const main = seedGraph({ orgs, signals }, { tenants, seed });
        const proofs = await scaleSweep({
          subjects: [triage],
          entities: [orgs, signals],
          writer,
          main,
          seed,
          room,
          setup,
        });
        expect(proofs.get('triageSignal')).toEqual({ verdict: 'flat', expected: [] });
      });
    }
  }
});

/** Every one of the tenant's signals, as a list primitive reads them. */
const listSetup: ScaleSetup = async (_subject, graph, tenant) => ({
  actor: null,
  input: graph.inserts
    .filter((one) => one.entity === 'ssb_signals' && one.tenant === tenant)
    .map((one) => one.row),
});

/** One read of the list, then one events read PER closed signal: an N+1 over a filtered set. */
const perClosed = {
  name: 'closedEvents',
  call: async (input: unknown) => {
    const rows = (input as readonly { status?: string }[] | undefined) ?? [];
    const closed = rows.filter((row) => row.status === 'closed').length;
    sent = [
      { fingerprint: 'ssb_signals.findMany', count: 1, unexpected: 1 },
      ...(closed === 0
        ? []
        : [{ fingerprint: 'ssb_events.findMany', count: closed, unexpected: closed }]),
    ];
    return {};
  },
};

describe(testName('unit', 'scaleSweep · a loop over a filtered set'), () => {
  for (const seed of [2, 5, 11]) {
    test(`a read per closed row grows, though no closed row is in the 2-row graph (seed ${seed})`, async () => {
      const main = seedGraph({ orgs, signals }, { tenants: 2, seed });
      const proofs = await scaleSweep({
        subjects: [perClosed],
        entities: [orgs, signals],
        writer,
        main,
        seed,
        room,
        setup: listSetup,
      });
      expect(proofs.get('closedEvents')?.verdict).toBe('grows');
    });
  }
});
