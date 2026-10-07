// `recordPublisher` end to end on one in-process bus: committed rows an app hands it become change
// envelopes the sync node's own subscription reads — sequenced per producer, projected through the
// entity (no sealed or undeclared property rides), and delivered to a seated member as `records`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError, userActor, withWriteOrigin, writeDigest } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { InProcessTransport, type Transport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { OPEN_POLICY } from './policy-fake-fixture';
import { isPublishedTable, recordPublisher } from './record-publisher';
import { CHANGE_SUBJECT_ALL } from './replicator';
import { SeqGapDetector } from './replicator-envelope';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { changeHandler, ProducerKinds } from './sync-bus-handlers';

const ORG = '00000000-0000-4000-8000-0000000000b1';
const runs = entity('published_runs', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text(),
    token: text().nullable().sealed(),
  },
});
const lines = entity('published_lines', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), body: text() },
});
const board = channel('published-board', {
  params: ['orgId'],
  catchUp: { name: 'publishedBoard' },
  policy: OPEN_POLICY,
  records: [runs],
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

class FakeWs implements WsLike {
  readonly frames: Record<string, unknown>[] = [];
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  of(type: string): Record<string, unknown>[] {
    return this.frames.filter((frame) => frame['type'] === type);
  }
}

const run = (id: string, title: string) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  orgId: ORG,
  title,
  token: 'plaintext-secret',
  computed: 'not a column',
});

let transport: InProcessTransport;
let wire: { subject: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  transport = new InProcessTransport();
  wire = [];
  await transport.subscribe(CHANGE_SUBJECT_ALL, (payload, subject) => {
    wire.push({ subject, body: JSON.parse(payload) as Record<string, unknown> });
  });
});

describe('recordPublisher', () => {
  test('one envelope per row, sequenced under one producer, projected through the entity', async () => {
    using publisher = recordPublisher({ transport, entities: [runs] });
    await publisher.publish(runs, [run('1', 'first'), run('2', 'second')]);
    await publisher.publish(runs, [run('3', 'third')]);

    expect(wire.map((message) => message.body['seq'])).toEqual([1, 2, 3]);
    expect(new Set(wire.map((message) => message.body['producer']))).toEqual(
      new Set([publisher.producer]),
    );
    const [first] = wire;
    expect(first?.subject).toBe(`x.change.published_runs.${ORG}`);
    expect(first?.body).toMatchObject({
      table: 'published_runs',
      op: 'update',
      before: null,
      orgId: ORG,
      write: null,
      source: 'publisher',
    });
    // Neither the sealed column nor a property the entity never declared leaves the process.
    expect(first?.body['after']).toEqual({ id: run('1', '').id, orgId: ORG, title: 'first' });
  });

  test('a delete carries the old image and no new one', async () => {
    using publisher = recordPublisher({ transport, entities: [runs] });
    await publisher.publish(runs, [run('1', 'gone')], { op: 'delete' });
    expect(wire[0]?.body).toMatchObject({ op: 'delete', after: null });
    expect(wire[0]?.body['before']).toMatchObject({ id: run('1', '').id });
  });

  test('names the keyed write it runs inside, or the one it is handed', async () => {
    using publisher = recordPublisher({ transport, entities: [runs] });
    const digest = await writeDigest('startRun:0192f0c4-0000-7000-8000-000000000001');
    if (digest === undefined) return expect.unreachable('a key digests');
    await withWriteOrigin(digest, () => publisher.publish(runs, [run('1', 'mine')]));
    await publisher.publish(runs, [run('2', 'named')], { write: digest });
    await publisher.publish(runs, [run('3', 'none')], { write: null });
    expect(wire.map((message) => message.body['write'])).toEqual([digest, digest, null]);
  });

  test('reaches a seated member as a records frame through the node’s own subscription', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, channels: [board] });
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    await transport.subscribe(
      CHANGE_SUBJECT_ALL,
      changeHandler({ registry, hub, gaps: new SeqGapDetector(), producers: new ProducerKinds() }),
    );
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'm1', orgId: ORG }),
    });
    sockets.add(socket);
    await hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: board.name,
      params: { orgId: ORG },
    });

    using publisher = recordPublisher({ transport, entities: [runs] });
    await publisher.publish(runs, [run('1', 'live')]);
    await Bun.sleep(1);

    const [frame] = ws.of('records');
    expect(frame?.['adopt']).toEqual({
      published_runs: { [run('1', '').id]: { id: run('1', '').id, orgId: ORG, title: 'live' } },
    });
  });

  test('a send the bus refused rejects its caller, and its seq stays spent so nodes see the hole', async () => {
    const refusing: Transport = {
      name: 'refusing',
      shared: transport.shared,
      subscribe: (subject, handler) => transport.subscribe(subject, handler),
      onReconnect: () => () => undefined,
      close: () => transport.close(),
      publish: async (subject, payload) => {
        // The bus refusing seq 1 is the INPUT under test, handed in as a rejection.
        if ((JSON.parse(payload) as { seq: number }).seq === 1)
          return Promise.reject(new TypeError('bus down'));
        await transport.publish(subject, payload);
      },
    };
    using publisher = recordPublisher({ transport: refusing, entities: [runs] });
    // The refused row is the first of the call: the one behind it still goes.
    await expect(publisher.publish(runs, [run('1', 'lost'), run('2', 'kept')])).rejects.toThrow(
      'bus down',
    );
    await publisher.publish(runs, [run('3', 'next')]);
    expect(wire.map((message) => message.body['seq'])).toEqual([2, 3]);
  });

  test('claims its entities for the process until closed', () => {
    const publisher = recordPublisher({ transport, entities: [runs] });
    expect(isPublishedTable('published_runs')).toBe(true);
    expect(isPublishedTable('published_lines')).toBe(false);
    publisher.close();
    publisher.close();
    expect(isPublishedTable('published_runs')).toBe(false);
  });
});

// The bus speaks RELATIONS (`ChangeEvent.table`, the subject, `reviveBusRow`), the store speaks
// entity NAMES: an entity adopting a table under another name must arrive under both, correctly.
describe('an entity whose table is not its name', () => {
  const ledger = entity('published_ledger', {
    table: 'published_gl_entries',
    columns: { id: uuid().primaryKey(), orgId: uuid(), label: text() },
  });
  const ledgerBoard = channel('published-ledger', {
    params: ['orgId'],
    catchUp: { name: 'publishedLedger' },
    policy: OPEN_POLICY,
    records: [ledger],
  });

  test('is published under its table and adopted under its name', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, channels: [ledgerBoard] });
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    await transport.subscribe(
      CHANGE_SUBJECT_ALL,
      changeHandler({ registry, hub, gaps: new SeqGapDetector(), producers: new ProducerKinds() }),
    );
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'm1', orgId: ORG }),
    });
    sockets.add(socket);
    await hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: ledgerBoard.name,
      params: { orgId: ORG },
    });

    using publisher = recordPublisher({ transport, entities: [ledger] });
    const id = run('1', '').id;
    await publisher.publish(ledger, [{ id, orgId: ORG, label: 'entry' }]);
    await Bun.sleep(1);

    expect(wire[0]?.subject).toBe(`x.change.published_gl_entries.${ORG}`);
    expect(wire[0]?.body['table']).toBe('published_gl_entries');
    expect(ws.of('records')[0]?.['adopt']).toEqual({
      published_ledger: { [id]: { id, orgId: ORG, label: 'entry' } },
    });
    // The claim the x dev bridge asks is in the bus's vocabulary too.
    expect(isPublishedTable('published_gl_entries')).toBe(true);
  });
});

describe('what recordPublisher refuses', () => {
  const refusal = async (attempt: () => unknown): Promise<string> => {
    try {
      await attempt();
    } catch (error) {
      if (isUltimateError(error)) return error.code;
      throw error;
    }
    return expect.unreachable('the publish was accepted');
  };

  test('an entity it did not claim, a write that is no digest, a row with no key, a closed one', async () => {
    const publisher = recordPublisher({ transport, entities: [runs] });
    expect(await refusal(() => publisher.publish(lines, []))).toBe('X_INVARIANT');
    expect(
      await refusal(() => publisher.publish(runs, [run('1', 'x')], { write: 'likePost:1' })),
    ).toBe('X_INVARIANT');
    expect(await refusal(() => publisher.publish(runs, [{ orgId: ORG, title: 'keyless' }]))).toBe(
      'X_RECORD_KEY_MISSING',
    );
    publisher.close();
    expect(await refusal(() => publisher.publish(runs, [run('1', 'late')]))).toBe('X_INVARIANT');
    // Nothing a refusal stopped reached the bus.
    expect(wire).toEqual([]);
  });
});
