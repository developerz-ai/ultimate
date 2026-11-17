// Every change producer hoists the tenant from the column the ENTITY declares — `$tenantColumn` —
// never from a property literally called `orgId`. The write-ahead-log decoder and `recordPublisher`
// each read `row.orgId`, so a table declared `tenant: 'workspaceId'` published `orgId: null`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, entityForTable, text } from '@ultimat3/entity';
import { InProcessTransport } from './fanout';
import { begin, commit, insert, POSTS_OID, relation, start, xlog } from './pg-replication-fixture';
import { recordPublisher } from './record-publisher';
import { CHANGE_SUBJECT_ALL } from './replicator';

const A = '00000000-0000-4000-8000-0000000000a1';

/** Declared once per process, and again after another suite cleared the registry. */
function ensureEntities(): void {
  if (entityForTable('tc_ws_rows') === undefined) {
    entity('tc_ws_rows', {
      tenant: 'workspaceId',
      columns: { id: text().primaryKey(), workspaceId: text(), label: text() },
    });
  }
  if (entityForTable('tc_global_rows') === undefined) {
    entity('tc_global_rows', { columns: { id: text().primaryKey(), label: text() } });
  }
}

beforeEach(ensureEntities);
afterAll(() => {
  clearRegistry();
});

describe('the write-ahead-log decoder', () => {
  const replicate = async (table: string, columns: readonly string[], values: string[]) => {
    const { server, events, settled, feed } = await start({ entities: [table] });
    server.push(
      xlog(
        relation(
          POSTS_OID,
          table,
          columns.map((name, index) => ({ name, key: index === 0 })),
        ),
      ),
    );
    server.push(xlog(begin(0xd000n, 0n, 40)));
    server.push(xlog(insert(POSTS_OID, values)));
    server.push(xlog(commit(0xd000n, 0xd100n, 0n)));
    await settled(1);
    await feed.stop();
    return events;
  };

  test('hoists the tenant from a column named workspaceId', async () => {
    const events = await replicate('tc_ws_rows', ['id', 'workspace_id', 'label'], ['r1', A, 'x']);
    expect(events[0]?.orgId).toBe(A);
  });

  test('hoists it from orgId, as before', async () => {
    const events = await replicate('posts', ['id', 'title', 'org_id'], ['p1', 't', A]);
    expect(events[0]?.orgId).toBe(A);
  });

  test('an untenanted table carries no tenant', async () => {
    const events = await replicate('tc_global_rows', ['id', 'label'], ['g1', 'x']);
    expect(events[0]?.orgId).toBeNull();
  });
});

describe('recordPublisher', () => {
  test('hoists the tenant from a column named workspaceId, into the body and the subject', async () => {
    const transport = new InProcessTransport();
    const wire: { subject: string; body: Record<string, unknown> }[] = [];
    await transport.subscribe(CHANGE_SUBJECT_ALL, (payload, subject) => {
      wire.push({ subject, body: JSON.parse(payload) as Record<string, unknown> });
    });
    const rows = entityForTable('tc_ws_rows');
    if (rows === undefined) return expect.unreachable('declared in beforeEach');
    using publisher = recordPublisher({ transport, entities: [rows] });
    await publisher.publish(rows, [{ id: 'r1', workspaceId: A, label: 'x' }]);
    expect(wire[0]?.body['orgId']).toBe(A);
    expect(wire[0]?.subject).toBe(`x.change.tc_ws_rows.${A}`);
  });
});
