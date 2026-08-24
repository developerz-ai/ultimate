// What a FILTERED write reads back, and why it usually reads back nothing. Split from
// `pg-driver-filtered.test.ts`, which answers "did it write only the rows I bounded" — this file
// answers the question one layer down: how much of what it wrote crosses the wire. The two are
// different failures. The first is a leak; this one is a pod that dies holding twelve million rows
// nobody asked for, on a call whose answer is a number.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import type { EntityError } from './errors';
import { invariant, MAX_ASSERTED_ROWS } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ID = '00000000-0000-7000-8000-000000000101';

/**
 * Every rule this entity declares is a CHECK Postgres enforced on the statement itself, so a
 * filtered write has nothing left to judge and the answer is the count the command tag carries.
 * That is the ordinary entity, which is why this is the one the unconditional `returning *` cost
 * the most.
 */
const invoices = entity('readback_test_invoices', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    reference: text({ max: 40 }),
    total: money(),
    paid: boolean().default(false),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [invariant('total_non_negative', c.total.minor.atLeast(0))],
});

const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);

/**
 * The other half of the pair: `matches()` takes a JS predicate, so the rule binds as
 * `kind: 'assert'`, `sql: null` — there is no CHECK for Postgres to have enforced, and this is the
 * ONE shape whose filtered write has to read its rows back to judge them.
 */
const tickets = entity('readback_test_tickets', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    slug: text({ max: 40 }),
    note: text().nullable(),
  },
  invariants: (c) => [invariant('ticket_slug_shape', c.slug.matches(isSlug))],
});

type Ticket = typeof tickets.$row;

const ticketRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  org_id: ORG,
  slug: 'a-ticket',
  note: null,
  ...over,
});

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const lastText = (): string => client.texts.at(-1) ?? '';
const caught = async (work: Promise<unknown>): Promise<EntityError | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => error as EntityError,
  );

describe('a filtered write over an entity Postgres can judge on its own', () => {
  /**
   * The failure case, and the one this file exists for: `updateWhere` ended its statement in
   * `returning *` unconditionally and then looped `$assert` over the result. On a GDPR sweep —
   * `updateWhere({ orgId }, { marketingOptIn: false })` across twelve million rows — Postgres runs
   * one fine UPDATE and every row of it is then allocated in the app process, decoded, and judged
   * against nothing. `deleteWhere` on the same table was already a count, which is what made the
   * failure look arbitrary.
   */
  test('names no rows at all, and answers with the count', async () => {
    client.on('update', { affected: 12_000 });
    const written = await postgresRepo(invoices).updateWhere(
      { paid: false },
      { paid: true },
      { orgId: ORG },
    );

    expect(written).toBe(12_000);
    expect(lastText()).not.toContain('returning');
    // One statement. Nothing is counted first, because nothing has to come back to be counted.
    expect(client.statements).toHaveLength(1);
  });

  test('a soft delete names none either — the sibling that looked like the one doing it right', async () => {
    client.on('update', { affected: 12_000 });
    expect(await postgresRepo(invoices).deleteWhere({ paid: false }, { orgId: ORG })).toBe(12_000);
    // `deleteWhere` reads a count through `execute()`, so `returning *` there was rows nobody
    // could ever have read — the identical waste on the path the audit called correct.
    expect(lastText()).toStartWith('update "readback_test_invoices" set "deleted_at" = $1');
    expect(lastText()).not.toContain('returning');
  });

  test('an id-addressed update still reads its row back — that IS its answer', async () => {
    client.on('update', {
      rows: [
        {
          id: ID,
          org_id: ORG,
          reference: 'INV-2',
          total_minor: '100',
          total_currency: 'EUR',
          paid: false,
          deleted_at: null,
        },
      ],
    });
    expect(
      (await postgresRepo(invoices).update(ID, { reference: 'INV-2' }, { orgId: ORG })).reference,
    ).toBe('INV-2');
    expect(lastText()).toEndWith('returning *');
  });
});

describe('a filtered write over an entity only the app can judge', () => {
  const patch = () =>
    postgresRepo(tickets).updateWhere({ note: null }, { note: 'triaged' }, { orgId: ORG });

  test('reads its rows back, and judges every one of them', async () => {
    client.on('count(*)', { rows: [{ count: 2 }] });
    client.on('update', { rows: [ticketRow(), ticketRow({ slug: 'Not A Slug' })] });

    // The second row's slug is one no CHECK could have refused, which is the entire reason the
    // rows come back here and nowhere else.
    expect(await caught(patch())).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(lastText()).toEndWith('returning *');
  });

  test('the count comes first, so a refusal never allocates what it is refusing', async () => {
    client.on('count(*)', { rows: [{ count: MAX_ASSERTED_ROWS + 1 }] });
    const error = await caught(patch());

    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    // The whole point: the UPDATE never existed. A refusal after `returning *` would already be
    // holding the fifty thousand rows it was about to complain about.
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toContain('count(*)');
    // And the way out is the call that visits every row without holding them all.
    expect(String(error?.fix)).toContain('inBatches(1000)');
  });

  test('inside the bound it writes, and answers with the rows it judged', async () => {
    client.on('count(*)', { rows: [{ count: 1 }] });
    client.on('update', { rows: [ticketRow()] });
    expect(await patch()).toBe(1);
  });

  test('both drivers answer one filtered write the same way', async () => {
    const seed: Ticket = { id: ID, orgId: ORG, slug: 'a-ticket', note: null };
    const memory = memoryRepo(tickets, [seed]);
    client.on('count(*)', { rows: [{ count: 1 }] });
    client.on('update', { rows: [ticketRow({ note: 'triaged' })] });

    expect(await memory.updateWhere({ note: null }, { note: 'triaged' }, { orgId: ORG })).toBe(1);
    expect(await patch()).toBe(1);

    // And a patch that breaks the JS-only rule is refused by both, not by one of them.
    expect(
      await caught(memory.updateWhere({ note: 'triaged' }, { slug: 'Not A Slug' }, { orgId: ORG })),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
  });
});
