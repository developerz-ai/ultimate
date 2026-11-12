// What `latestBy` costs on the wire, from the Postgres driver's side: one statement per call, the
// `DISTINCT ON` shape without keys and the `LATERAL` shape with them, the scope inside it, the
// group bound. Counted against the recording client: "one statement" is a claim about SQL.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type RecordingClient, recordingClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { EntityError } from './errors';
import { type LatestBySpec, MAX_LATEST_GROUPS } from './latest-by';
import { postgresLatestBy } from './pg-latest-by';
import { clearRegistry } from './registry';

const messages = entity('latest_sql_messages', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    conversationId: uuid(),
    body: text({ max: 40 }),
    sentAt: timestamp(),
    deletedAt: timestamp().nullable(),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const ORG = idAt(1);

const physical = (index: number, group: number) => ({
  id: idAt(index),
  org_id: ORG,
  conversation_id: idAt(1000 + group),
  body: `m${index}`,
  sent_at: new Date(Date.UTC(2026, 10, 11)),
  deleted_at: null,
});

const newest: LatestBySpec = {
  group: 'conversationId',
  order: [{ column: 'sentAt', direction: 'desc' }],
  perGroup: 1,
};

let client: RecordingClient;
const repo = () => postgresLatestBy(messages, () => client);

beforeEach(() => {
  client = recordingClient();
});

afterAll(() => {
  clearRegistry();
});

describe('no keys: DISTINCT ON', () => {
  test('one statement, the group leading the order, the key breaking ties, the scope inside', async () => {
    client.on('latest_sql_messages', { rows: [physical(10, 0), physical(20, 1)] });
    const rows = await repo().latestBy(newest, { orgId: ORG });

    expect(rows).toHaveLength(2);
    expect(client.texts).toHaveLength(1);
    const [statement] = client.texts;
    expect(statement).toContain('select distinct on ("conversation_id")');
    expect(statement).toContain(
      'order by "conversation_id" asc nulls last, "sent_at" desc nulls first, "id" desc nulls first',
    );
    expect(statement).toContain('"deleted_at" is null');
    expect(statement).toContain('"org_id" =');
    expect(client.statements[0]?.values).toContain(ORG);
    // One group past the bound: its presence is the refusal.
    expect(client.statements[0]?.values).toContain(MAX_LATEST_GROUPS + 1);
  });

  test('a group past the bound is refused, never truncated', async () => {
    client.on('latest_sql_messages', {
      rows: Array.from({ length: MAX_LATEST_GROUPS + 1 }, (_, n) => physical(n, n)),
    });
    let error: unknown;
    try {
      await repo().latestBy(newest, { orgId: ORG });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EntityError);
    expect((error as EntityError).message).toContain(`more than ${MAX_LATEST_GROUPS} groups`);
  });
});

describe('keys: LATERAL', () => {
  test('one statement over the keys, typed by the table, n rows per key', async () => {
    client.on('latest_sql_messages', { rows: [physical(10, 0), physical(11, 0)] });
    await repo().latestBy(
      { ...newest, perGroup: 2, keys: [idAt(1000), idAt(1001), null] },
      { orgId: ORG },
    );

    expect(client.texts).toHaveLength(1);
    const [statement] = client.texts;
    expect(statement).toContain(
      'from (select "conversation_id" as "V$LB" from "latest_sql_messages" where false union all select $1 union all select $2) as "K$LB" cross join lateral (',
    );
    expect(statement).toContain('where "conversation_id" = "K$LB"."V$LB" and');
    expect(statement).toContain(
      'order by "sent_at" desc nulls first, "id" desc nulls first limit $',
    );
    expect(statement).toContain('order by "L$LB"."conversation_id" asc nulls last');
    // The null key is no parent and binds nothing.
    expect(client.statements[0]?.values.slice(0, 2)).toEqual([idAt(1000), idAt(1001)]);
    expect(client.statements[0]?.values).toContain(2);
  });

  test('past 500 keys it is one statement per 500, each carrying only its own keys', async () => {
    client.on('latest_sql_messages', { rows: [] });
    const keys = Array.from({ length: 501 }, (_, n) => idAt(5000 + n));
    await repo().latestBy({ ...newest, keys }, { orgId: ORG });

    expect(client.texts).toHaveLength(2);
    expect(client.statements[1]?.values).not.toContain(idAt(5000));
  });

  test('no key sends nothing, and is still judged', async () => {
    expect(await repo().latestBy({ ...newest, keys: [] }, { orgId: ORG })).toEqual([]);
    expect(client.texts).toHaveLength(0);
    await expect(
      repo().latestBy({ ...newest, group: 'sentAt', keys: [] }, { orgId: ORG }),
    ).rejects.toBeInstanceOf(EntityError);
  });
});
