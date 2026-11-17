// `normalize` — the replicator's step between the feed and the bus — must not invent a tenant. It
// hoisted `row.orgId` into a change that carried none, the same assumption 31.38.1 removed from the
// three producers. Reachable on a table whose tenant column is NOT `orgId` and whose key-only
// DELETE image (REPLICA IDENTITY DEFAULT) holds an `orgId` column of another meaning: the decoder
// rightly sends no tenant, `normalize` stamped the `orgId` value, and the window of the row's real
// tenant dropped the delete (`canAffect`) — a deleted row left on its subscribers' screens. Every
// node subscribes to `x.change.>`, so the subject routes nothing; the org on the change is what
// every window filters by.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, entityForTable, text } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { InProcessTransport } from './fanout';
import { canAffect, type SubscriptionShape } from './matcher-bridge';
import { begin, commit, POSTS_OID, relation, remove, start, xlog } from './pg-replication-fixture';
import { CHANGE_SUBJECT_ALL } from './replicator';
import { parseEnvelope } from './replicator-envelope';
import { rig } from './replicator-rig-fixture';
import { normalize } from './replicator-subject';

const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
const TABLE = 'rt_keyed_rows';

/** Tenant `workspaceId`; `orgId` is an ordinary column, half of a composite key. */
function ensureEntity(): void {
  if (entityForTable(TABLE) !== undefined) return;
  entity(TABLE, {
    tenant: 'workspaceId',
    primaryKey: ['orgId', 'id'],
    columns: { orgId: text(), id: text(), workspaceId: text(), label: text() },
  });
}

beforeEach(ensureEntity);
afterAll(() => {
  clearRegistry();
});

/** The decoder's own event for a DEFAULT-identity delete: the key columns, and no tenant. */
async function decodedDelete(): Promise<ChangeEvent> {
  const { server, events, settled, feed } = await start({ entities: [TABLE] });
  const columns = [
    { name: 'org_id', key: true },
    { name: 'id', key: true },
    { name: 'workspace_id' },
    { name: 'label' },
  ];
  server.push(xlog(relation(POSTS_OID, TABLE, columns, 'd')));
  server.push(xlog(begin(0xf000n, 0n, 60)));
  server.push(xlog(remove(POSTS_OID, [OTHER_ORG, 'r1', null, null])));
  server.push(xlog(commit(0xf000n, 0xf100n, 0n)));
  await settled(1);
  await feed.stop();
  const [deleted] = events;
  if (deleted === undefined) return expect.unreachable('the delete was decoded');
  return deleted;
}

const tenantWindow: SubscriptionShape = {
  qid: 'q',
  entities: [TABLE],
  orgId: WORKSPACE,
  tenantTables: [TABLE],
};

describe('unit · the replicator publishes the tenant the producer read, and no other', () => {
  test('a key-only delete stays tenant-less through normalize', async () => {
    const deleted = await decodedDelete();
    expect(deleted.orgId).toBeNull();
    expect(normalize(deleted)?.orgId ?? null).toBeNull();
  });

  test('over the bus, the delete still reaches the window of the row’s real tenant', async () => {
    const deleted = await decodedDelete();
    const transport = new InProcessTransport();
    const wire: { subject: string; payload: string }[] = [];
    await transport.subscribe(CHANGE_SUBJECT_ALL, (payload, subject) => {
      wire.push({ subject, payload });
    });
    const { feed, replicator } = rig(transport);
    expect(await replicator.start()).toBe(true);
    await feed.deliver(deleted);
    await replicator.stop();

    const published = wire.map(({ payload }) => parseEnvelope(payload)?.change ?? null);
    const change = published.find((each) => each?.table === TABLE);
    if (change === undefined || change === null) return expect.unreachable('it was published');
    expect(change.orgId).toBeNull();
    expect(wire.find(({ payload }) => payload.includes(TABLE))?.subject).toBe(
      `x.change.${TABLE}._`,
    );
    // `bridgeChange` then keeps the delete only for an id this window holds: no other org learns it.
    expect(canAffect(tenantWindow, change)).toBe(true);
  });

  test('a change that already names its tenant keeps it', async () => {
    const deleted = await decodedDelete();
    const named = { ...deleted, orgId: WORKSPACE };
    expect(normalize(named)).toBe(named);
  });
});
