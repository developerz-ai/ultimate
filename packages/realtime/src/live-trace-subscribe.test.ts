// A live subscribe joins the page's trace end to end: the client puts its `traceparent` on the
// `subscribe` frame, the node keeps it on the window, the snapshot that subscribe causes is a
// CHILD of it and a re-run a change forces names it as a LINK. A garbage value is dropped where
// it is read — telemetry never fails a subscribe.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  memoryExporter,
  parseTraceparent,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
  userActor,
} from '@ultimat3/core';
import { from, query, registerQuery, resetQueries, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { LiveClient } from './client';
import { FakeSocket } from './client-harness-fixture';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, SnapshotArgs } from './live-contract';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { fillWindow, noteTraceparent, queryEntry, refillWindowInLane } from './query-window';
import { SyncSocket, type WsLike } from './socket';
import { decode, encode } from './sync-protocol';
import { PROTOCOL_VERSION } from './wire-version';

const PAGE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const page = parseTraceparent(PAGE);

afterEach(() => {
  resetTelemetry();
  resetInstrumentation();
  resetQueries();
});

const subscribeFrame = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'subscribe',
    v: PROTOCOL_VERSION,
    op: 'add',
    sid: 's1',
    target: { kind: 'query', qid: 'feed', input: {}, cursor: null },
    ...extra,
  });

describe('the subscribe frame carries a traceparent', () => {
  test('a string survives decode; a non-string or an oversized one is dropped, never refused', () => {
    const kept = decode(subscribeFrame({ traceparent: PAGE }));
    expect(kept.type === 'subscribe' ? kept.traceparent : undefined).toBe(PAGE);
    for (const garbage of [42, { a: 1 }, 'x'.repeat(500)]) {
      const frame = decode(subscribeFrame({ traceparent: garbage }));
      expect(frame.type).toBe('subscribe');
      expect(frame.type === 'subscribe' ? frame.traceparent : 'kept').toBeUndefined();
    }
  });

  test("the client sends its option's value, and none when it has none", () => {
    const sent = (traceparent?: () => string | undefined): unknown => {
      const socket = new FakeSocket();
      const client = new LiveClient({
        connect: () => socket,
        buildId: 'build-1',
        heartbeatMs: 0,
        catchUp: async () => undefined,
        ...(traceparent === undefined ? {} : { traceparent }),
      });
      client.connect();
      socket.open();
      client.subscribeLive({ name: 'feed' }, {});
      const frame = socket.frames().find((each) => each.type === 'subscribe');
      client.close();
      return frame?.type === 'subscribe' ? frame.traceparent : 'no subscribe sent';
    };
    expect(sent(() => PAGE)).toBe(PAGE);
    expect(sent()).toBeUndefined();
    expect(sent(() => undefined)).toBeUndefined();
  });
});

class FakeWs implements WsLike {
  send(data: string): number {
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

function registry(): LiveQueryRegistry {
  const target = registerQuery(
    'tracedFeed',
    query({
      input: t.object({}),
      policy: {
        kind: 'allow',
        label: 'public',
        permissions: [],
        children: [],
        run: () => ({ allowed: true }),
      },
      live: true,
      sql: () =>
        from<Row>('posts', async () => [{ id: 'p1' }])
          .orderBy('id')
          .limit(10),
    }),
  );
  const ctx = ctxOf({ role: 'sync', buildId: 'build-1' });
  return new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
    liveQueryDefinition(target, { ctx }),
  );
}

const socket = (): SyncSocket =>
  new SyncSocket({
    ws: new FakeWs(),
    id: 'sock-1',
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: userActor({ id: 'ada', orgId: 'o1' }),
  });

describe('the node joins the trace', () => {
  test("the snapshot a subscribe causes is a child of the subscriber's trace", async () => {
    const exporter = memoryExporter();
    subscribe('span.end', (event) => exporter.export(event.payload));
    const { frame } = await registry().subscribe({
      socket: socket(),
      name: 'tracedFeed',
      input: {},
      traceparent: PAGE,
    });
    expect(frame.type).toBe('snapshot');
    const span = exporter.spans.find((one) => one.name === 'live.snapshot tracedFeed');
    expect(span?.context.traceId).toBe(page?.traceId ?? 'no page trace');
    expect(span?.parentSpanId).toBe(page?.spanId ?? 'no page span');
  });

  test('a garbage header starts a fresh trace, and the subscribe is still served', async () => {
    const exporter = memoryExporter();
    subscribe('span.end', (event) => exporter.export(event.payload));
    const { frame } = await registry().subscribe({
      socket: socket(),
      name: 'tracedFeed',
      input: {},
      traceparent: '00-not-a-trace',
    });
    expect(frame.type === 'snapshot' ? frame.rows.map((row) => row.id) : []).toEqual(['p1']);
    const span = exporter.spans.find((one) => one.name === 'live.snapshot tracedFeed');
    expect(span?.parentSpanId).toBeUndefined();
    expect(span?.context.traceId).not.toBe(page?.traceId);
  });
});

describe("the window's reads say why they run", () => {
  test('a subscribe read is a snapshot, a forced re-read is a rerun, both with the trace', async () => {
    const seen: SnapshotArgs[] = [];
    const definition: LiveQueryDefinition = {
      name: 'stub',
      entities: ['posts'],
      snapshot: async (args) => {
        seen.push(args);
        return { rows: [], lsn: '' };
      },
      visible: () => true,
      matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
    };
    const input: JsonValue = {};
    const entry = queryEntry('q1', definition, input, definition.matcher(input));
    noteTraceparent(entry, PAGE);
    await fillWindow(entry);
    await refillWindowInLane(entry);
    expect(seen.map((args) => [args.phase, args.traceparent])).toEqual([
      ['snapshot', PAGE],
      ['rerun', PAGE],
    ]);
  });

  test('an oversized value is never kept on the window', () => {
    const definition = { name: 'stub' } as LiveQueryDefinition;
    const entry = queryEntry(
      'q1',
      definition,
      {},
      { entities: [], match: () => ({ patches: [], refill: false }) },
    );
    noteTraceparent(entry, 'x'.repeat(500));
    expect(entry.traceparent).toBeNull();
  });
});

test('encode round-trips the traceparent', () => {
  const frame = decode(subscribeFrame({ traceparent: PAGE }));
  expect(decode(encode(frame))).toEqual(frame);
});
