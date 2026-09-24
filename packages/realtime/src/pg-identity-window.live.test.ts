// The claim `X_LIVE_REPLICA_IDENTITY` rests on, proved end to end: a KEYED table on the default
// replica identity — real WAL, real `pgoutput`, a real live query — delivers exactly the right
// patches when a row moves OUT of the window, moves IN, is deleted, or is updated while the window
// never held it. Under DEFAULT an update carries no old tuple and a delete carries the key alone;
// the shared window is what holds the whole row the decision needs.
//
// Skips unless TEST_REPLICATION_URL names a server with `wal_level = logical` — see
// `pg-replication.live.test.ts` for the one-line container.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { clearRegistry, entity, entityForTable, text } from '@ultimat3/entity';
import { from, type QueryPolicy, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, PgLogicalReplicationFeed } from './changefeed';
import type { Row } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const url = Bun.env['TEST_REPLICATION_URL'];
const ready = url !== undefined && url !== '';

const TABLE = 'x_idw_posts';
const SLOT = 'x_idw_slot';
const PUBLICATION = 'x_idw_pub';

interface PostRow extends Row {
  readonly orgId: string;
  readonly status: string;
  readonly title: string;
}

/** Structural, as `live-definition.test.ts` builds one: realtime reaches policy only via query. */
const everyone: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

if (entityForTable(TABLE) === undefined) {
  entity(TABLE, {
    columns: { id: text().primaryKey(), orgId: text(), status: text(), title: text() },
  });
}

// File scope, so a skipped suite still unregisters what its module body registered.
afterAll(() => {
  clearRegistry();
  resetRegistry();
});

const connect = async (): Promise<PgConnection> => {
  const target = parsePgUrl(url ?? '');
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: target.user,
    password: target.password,
    database: target.database,
    applicationName: 'ultimate-identity-window-test',
  });
};

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

describe.skipIf(!ready)('live · a keyed table on REPLICA IDENTITY DEFAULT', () => {
  let sql: PgConnection;
  let reader: PgConnection;
  let feed: PgLogicalReplicationFeed;
  const events: ChangeEvent[] = [];
  const ws = new FakeWs();
  let delivered: Promise<unknown> = Promise.resolve();

  const reset = async (): Promise<void> => {
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
  };

  /** Every patch the subscriber was sent since the last call, as `op:id`. */
  const patchesSince = (() => {
    let seen = 0;
    return (): string[] => {
      const fresh = ws.frames.slice(seen);
      seen = ws.frames.length;
      return fresh.flatMap((frame) =>
        frame.type === 'patch' ? frame.patches.map((patch) => `${patch.op}:${patch.id}`) : [],
      );
    };
  })();

  /** Waits until `count` changes have been decoded AND delivered to the registry. */
  const settle = async (count: number): Promise<void> => {
    for (let poll = 0; poll < 200 && events.length < count; poll += 1) await Bun.sleep(25);
    await delivered;
  };

  beforeAll(async () => {
    sql = await connect();
    reader = await connect();
    await reset();
    await sql.query(
      `CREATE TABLE ${TABLE} (id text PRIMARY KEY, org_id text NOT NULL, status text NOT NULL, title text NOT NULL)`,
    );
    // DEFAULT, stated so the case cannot drift: the identity under test.
    await sql.query(`ALTER TABLE ${TABLE} REPLICA IDENTITY DEFAULT`);
    await sql.query(
      `INSERT INTO ${TABLE} VALUES ('a', 'o1', 'published', 'A'), ('b', 'o1', 'draft', 'B'), ('c', 'o1', 'draft', 'C')`,
    );

    resetRegistry();
    const target = registerQuery(
      'publishedPosts',
      query({
        input: t.object({ status: t.string }),
        policy: everyone,
        live: true,
        sql: ({ status }) =>
          from<PostRow>(TABLE, async () =>
            (await reader.query(`SELECT id, org_id, status, title FROM ${TABLE} ORDER BY id`)).map(
              ([id, orgId, rowStatus, title]) => ({
                id: id ?? '',
                orgId: orgId ?? '',
                status: rowStatus ?? '',
                title: title ?? '',
              }),
            ),
          )
            .where({ status })
            .orderBy('id')
            .limit(50),
      }),
    );
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    registry.register(
      liveQueryDefinition(target, { ctx: createContext({ role: 'sync', buildId: 'build-1' }) }),
    );
    const socket = new SyncSocket({
      ws,
      id: 's-1',
      clientBuildId: 'build-1',
      serverBuildId: 'build-1',
      actor: userActor({ id: 'alice', orgId: 'o1' }),
    });

    feed = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: SLOT,
      publication: PUBLICATION,
      entities: [TABLE],
      statusIntervalMs: 250,
    });
    await feed.start({
      onChange: (event) => {
        events.push(event);
        delivered = delivered.then(() => registry.deliver(event));
      },
    });
    const { frame } = await registry.subscribe({
      socket,
      name: 'publishedPosts',
      input: { status: 'published' },
    });
    if (frame.type !== 'snapshot') return expect.unreachable('expected a snapshot');
    expect(frame.rows.map((row) => row.id)).toEqual(['a']);
    patchesSince();
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await feed?.stop();
    await reset();
    await reader.close();
    await sql.close();
  });

  test('an update moving a row OUT of the filter removes it — with no old tuple at all', async () => {
    await sql.query(`UPDATE ${TABLE} SET status = 'draft' WHERE id = 'a'`);
    await settle(1);
    expect(events[0]?.op).toBe('update');
    // DEFAULT on a non-key update: Postgres sends NO before-image.
    expect(events[0]?.before).toBeNull();
    expect(patchesSince()).toEqual(['delete:a']);
  });

  test('an update moving a row IN inserts it, whole', async () => {
    await sql.query(`UPDATE ${TABLE} SET status = 'published' WHERE id = 'b'`);
    await settle(2);
    expect(events[1]?.before).toBeNull();
    const frame = ws.frames.at(-1);
    expect(patchesSince()).toEqual(['insert:b']);
    if (frame?.type !== 'patch') return expect.unreachable('expected a patch frame');
    expect(frame.patches[0]?.row).toMatchObject({ id: 'b', status: 'published', title: 'B' });
  });

  test('a delete of a held row, whose before-image is the key alone, deletes it', async () => {
    await sql.query(`DELETE FROM ${TABLE} WHERE id = 'b'`);
    await settle(3);
    const before: Readonly<Record<string, unknown>> = events[2]?.before ?? {};
    // Key-only: every non-key column absent or null.
    expect(before['id']).toBe('b');
    expect(before['title'] ?? null).toBeNull();
    expect(before['status'] ?? null).toBeNull();
    expect(patchesSince()).toEqual(['delete:b']);
  });

  test('a row the window never held, updated while still outside the filter, sends nothing', async () => {
    await sql.query(`UPDATE ${TABLE} SET status = 'archived', title = 'C2' WHERE id = 'c'`);
    await settle(4);
    expect(events).toHaveLength(4);
    expect(patchesSince()).toEqual([]);
  });

  test('and a delete of a row the window never held sends nothing either', async () => {
    await sql.query(`DELETE FROM ${TABLE} WHERE id = 'c'`);
    await settle(5);
    expect(patchesSince()).toEqual([]);
  });
});
