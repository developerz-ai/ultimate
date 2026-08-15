// What one microtask of point lookups buys a request: one statement, an answer per id, and the
// scope that statement carried. The scope guard is the claim — a coalesced row is served only to a
// lookup the statement WAS, so a batch can never answer with rows its caller's own could not.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createContext,
  runWithContext,
  serviceActor,
  userActor,
  withChildContext,
} from '@ultimat3/core';
import {
  createRecordingClient,
  type DbClient,
  type RecordingClient,
  setDbClient,
} from '@ultimat3/db';
import { MAX_IDS_PER_STATEMENT } from './batch-read';
import { money, text, timestamp, uuid } from './columns';
import { CROSS_TENANT_SCOPE, crossTenant } from './cross-tenant';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const invoices = entity('coalesce_test_invoices', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    reference: text({ max: 40 }),
    total: money(),
    deletedAt: timestamp().nullable(),
  },
});

const notes = entity('coalesce_test_notes', {
  columns: { id: uuid().primaryKey(), body: text() },
});

const likes = entity('coalesce_test_likes', {
  columns: { postId: uuid().primaryKey(), userId: uuid().primaryKey() },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ORG = idAt(1);
const OTHER_ORG = idAt(2);

/** What Bun.SQL hands back: snake_case names, int8 as a string. */
const physical = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  org_id: ORG,
  reference: `INV-${id.slice(-2)}`,
  total_minor: '100',
  total_currency: 'EUR',
  deleted_at: null,
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

const repo = () => postgresRepo(invoices);
// The tenant is the actor's, so a request that reads a tenant-scoped table is a request with an
// actor that carries one — `{ orgId: ORG }` on the call below is now a restatement of it.
const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: idAt(90), orgId: ORG }) }), work);

/** A support-tool request: the one shape that may read two tenants, and it says so out loud. */
const acrossTenants = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(
    createContext({
      actor: serviceActor({ id: idAt(91), orgId: ORG, scopes: [CROSS_TENANT_SCOPE] }),
    }),
    () => crossTenant('a support tool reads two tenants in one request', work),
  );

describe('the tenant a batch carries', () => {
  test('is derived before the batch is joined, though no caller named one', async () => {
    // The ordering claim: the driver builds the plan through `scopedPlan` and hands THAT to the
    // coalescer, so a batch cannot exist before the actor's tenant is on it. Nothing here passes
    // an org, and the statement still binds one.
    client.on('select', { rows: [physical(idAt(10)), physical(idAt(11))] });
    await inRequest(() => Promise.all([repo().findById(idAt(10)), repo().findById(idAt(11))]));

    expect(client.statements).toHaveLength(1);
    expect(client.texts[0]).toContain('"org_id" = $3');
    expect(client.statements[0]?.values).toEqual([idAt(10), idAt(11), ORG, 2]);
  });

  test('an impersonated actor never joins the batch it did not open', async () => {
    client.on('select', { rows: [physical(idAt(10))] });
    await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10)),
        // Same request, same microtask, a different actor: the batch map is keyed by context
        // identity and `withChildContext` mints a new one, so the parent's open statement is not
        // there to join even before the scope key is compared.
        withChildContext({ actor: userActor({ id: idAt(92), orgId: OTHER_ORG }) }, () =>
          repo().findById(idAt(11)),
        ),
      ]),
    );

    expect(client.statements).toHaveLength(2);
    expect(client.statements[0]?.values).toEqual([idAt(10), ORG, 1]);
    expect(client.statements[1]?.values).toEqual([idAt(11), OTHER_ORG, 1]);
  });
});

describe('findById coalescing', () => {
  test('point lookups issued in one microtask become one statement', async () => {
    // Reversed on purpose: rows come back in whatever order Postgres returns them, so a caller
    // served by position instead of by id would get another caller's row.
    client.on('select', { rows: [physical(idAt(11)), physical(idAt(10))] });
    const rows = await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        repo().findById(idAt(11), { orgId: ORG }),
        repo().findById(idAt(12), { orgId: ORG }),
      ]),
    );

    expect(client.statements).toHaveLength(1);
    expect(client.texts[0]).toContain('"id" in ($1, $2, $3)');
    expect(client.statements[0]?.values).toEqual([idAt(10), idAt(11), idAt(12), ORG, 3]);
    expect(rows[0]?.id).toBe(idAt(10));
    expect(rows[1]?.id).toBe(idAt(11));
    // An id the statement did not answer for is `findById`'s null, not a rejection.
    expect(rows[2]).toBeNull();
  });

  test('the coalesced statement carries the scope the single one carried', async () => {
    await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        repo().findById(idAt(11), { orgId: ORG }),
      ]),
    );
    expect(client.texts[0]).toContain('"org_id" = $3');
    expect(client.texts[0]).toContain('"deleted_at" is null');
    expect(client.texts[0]).toContain('order by "id" asc');
  });

  test('a row is decoded by the columns that declared it', async () => {
    client.on('select', { rows: [physical(idAt(10))] });
    const [row] = await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        repo().findById(idAt(11), { orgId: ORG }),
      ]),
    );
    expect(row?.total).toEqual({ minor: 100, currency: 'EUR' });
    expect(row?.deletedAt).toBeNull();
  });

  test('the same id twice is one bind and one row', async () => {
    client.on('select', { rows: [physical(idAt(10))] });
    const [first, second] = await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        repo().findById(idAt(10), { orgId: ORG }),
      ]),
    );
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]?.values).toEqual([idAt(10), ORG, 1]);
    // The in-memory driver hands every caller the same row object; so does this one.
    expect(first).toBe(second);
  });

  test('a uuid asked for in upper case is the row Postgres would have matched', async () => {
    const mixed = '0000000a-000b-7000-8000-00000000000c';
    client.on('select', { rows: [physical(mixed)] });
    const [upper, lower] = await inRequest(() =>
      Promise.all([
        repo().findById(mixed.toUpperCase(), { orgId: ORG }),
        repo().findById(mixed, { orgId: ORG }),
      ]),
    );
    // One bind: Postgres compares a uuid as a value and would have matched either spelling, so
    // the two spellings must not become two lookups — or the answer would depend on the batch.
    expect(client.statements[0]?.values).toEqual([mixed.toUpperCase(), ORG, 1]);
    expect(upper?.id).toBe(mixed);
    expect(lower).toBe(upper);
  });

  test('a row that no longer decodes fails its own caller, not the batch', async () => {
    // `reference` is not-null, so a null from the database means the table no longer matches the
    // entity. That is this row's problem: the caller of the other id still gets their row.
    client.on('select', {
      rows: [physical(idAt(10), { reference: null }), physical(idAt(11))],
    });
    await inRequest(async () => {
      // Both issued before either is asserted on: an assertion between them would be an await,
      // and the batch would be two batches.
      const broken = repo().findById(idAt(10), { orgId: ORG });
      const fine = repo().findById(idAt(11), { orgId: ORG });
      await Promise.all([
        expect(broken).rejects.toBeUltimateError('X_INVARIANT_VIOLATED'),
        expect(fine).resolves.toHaveProperty('reference', 'INV-11'),
      ]);
    });
    expect(client.statements).toHaveLength(1);
  });

  test('a batch wider than the cap becomes whole statements, never one Postgres refuses', async () => {
    const ids = Array.from({ length: MAX_IDS_PER_STATEMENT + 1 }, (_, index) => idAt(100 + index));
    const rows = await inRequest(() =>
      Promise.all(ids.map((id) => repo().findById(id, { orgId: ORG }))),
    );
    expect(client.statements).toHaveLength(2);
    // ids + the org predicate + the limit.
    expect(client.statements[0]?.values).toHaveLength(MAX_IDS_PER_STATEMENT + 2);
    expect(client.statements[1]?.values).toHaveLength(3);
    expect(rows).toHaveLength(MAX_IDS_PER_STATEMENT + 1);
    expect(rows.every((row) => row === null)).toBe(true);
  });

  test('a failed statement fails every caller in it', async () => {
    let sent = 0;
    const fail = (): Promise<never> => {
      sent += 1;
      return Promise.reject(new RangeError('boom'));
    };
    const broken: DbClient = { query: fail, one: fail, execute: fail };
    const pinned = postgresRepo(invoices, { client: broken });
    await inRequest(async () => {
      const first = pinned.findById(idAt(10), { orgId: ORG });
      const second = pinned.findById(idAt(11), { orgId: ORG });
      // Held before either is asserted on: the batch rejects every caller in one tick, and an
      // assertion is an await, so the second rejection would arrive with nobody holding it.
      const held = Promise.allSettled([first, second]);
      await expect(first).rejects.toThrow('boom');
      await expect(second).rejects.toThrow('boom');
      await held;
    });
    expect(sent).toBe(1);
  });
});

describe('what never shares a statement', () => {
  test('with no request in scope every lookup is the statement it always was', async () => {
    await Promise.all([
      repo().findById(idAt(10), { orgId: ORG }),
      repo().findById(idAt(11), { orgId: ORG }),
      repo().findById(idAt(12), { orgId: ORG }),
    ]);
    expect(client.statements).toHaveLength(3);
    expect(client.texts.every((statement) => statement.includes('"id" = $1'))).toBe(true);
  });

  test('two tenants never coalesce into one statement', async () => {
    // The one request that may read two tenants at all, so it is the one that can prove the scope
    // key keeps them apart: `crossTenant` lifts the guard, never the coalescer's scope.
    await acrossTenants(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        repo().findById(idAt(11), { orgId: OTHER_ORG }),
      ]),
    );
    expect(client.statements).toHaveLength(2);
    expect(client.statements[0]?.values).toEqual([idAt(10), ORG, 1]);
    expect(client.statements[1]?.values).toEqual([idAt(11), OTHER_ORG, 1]);
  });

  test('a lookup that reveals soft-deleted rows never joins one that hides them', async () => {
    // `RepoOptions` is what `findById` takes, and `shapeOf` reads `includeDeleted` off it — the
    // live suite passes it, so the two visibilities have to be two statements.
    const revealed = { orgId: ORG, includeDeleted: true };
    await inRequest(() =>
      Promise.all([repo().findById(idAt(10), { orgId: ORG }), repo().findById(idAt(11), revealed)]),
    );
    expect(client.statements).toHaveLength(2);
    expect(client.texts.filter((statement) => statement.includes('"deleted_at" is null'))).toEqual([
      client.texts[0] ?? '',
    ]);
  });

  test('two entities are two statements', async () => {
    await inRequest(() =>
      Promise.all([
        repo().findById(idAt(10), { orgId: ORG }),
        postgresRepo(notes).findById(idAt(11)),
      ]),
    );
    expect(client.statements).toHaveLength(2);
    expect(client.texts[0]).toContain('from "coalesce_test_invoices"');
    expect(client.texts[1]).toContain('from "coalesce_test_notes"');
  });

  test('a batch belongs to one request, so two requests are two statements', async () => {
    await Promise.all([
      inRequest(() => repo().findById(idAt(10), { orgId: ORG })),
      inRequest(() => repo().findById(idAt(11), { orgId: ORG })),
    ]);
    expect(client.statements).toHaveLength(2);
  });

  test('the window is one microtask: a lookup after an await opens the next statement', async () => {
    await inRequest(async () => {
      await repo().findById(idAt(10), { orgId: ORG });
      await repo().findById(idAt(11), { orgId: ORG });
    });
    expect(client.statements).toHaveLength(2);
  });
});

describe('the guards a point lookup already had', () => {
  test('a tenant-scoped lookup by an actor with no tenant never reaches a statement', async () => {
    // Inside a request there is no unscoped lookup left to catch — the actor's tenant is applied
    // whether or not the caller named one — so what is refused here is an actor carrying none.
    await runWithContext(createContext(), async () => {
      await expect(repo().findById(idAt(10))).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_ORG_REQUIRED',
      );
    });
    expect(client.statements).toHaveLength(0);
  });

  test('a composite primary key is still refused, batching or not', async () => {
    await inRequest(async () => {
      await expect(postgresRepo(likes).findById(idAt(10))).rejects.toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
    });
    expect(client.statements).toHaveLength(0);
  });
});
