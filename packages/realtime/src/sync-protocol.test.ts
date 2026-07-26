import { describe, expect, test } from 'bun:test';
import { ProtocolVersionError } from './errors';
import {
  decode,
  encode,
  FRAME_KINDS,
  type Frame,
  type FrameKind,
  PROTOCOL_VERSION,
} from './sync-protocol';

const cursor = {
  qid: 'liveFeed:abcd1234',
  lsn: '0000000000000009',
  digest: 'deadbeef',
  ids: ['p1', 'p2'],
  count: 2,
  at: 1_700_000_000_000,
};

const fixtures: Record<FrameKind, Frame> = {
  hello: {
    type: 'hello',
    v: PROTOCOL_VERSION,
    buildId: 'build-1',
    sessionId: null,
    actorId: 'alice',
    resume: [cursor],
  },
  subscribe: {
    type: 'subscribe',
    v: PROTOCOL_VERSION,
    op: 'add',
    sid: 'sid-1',
    target: { kind: 'query', qid: 'liveFeed', input: { orgId: 'o1' }, cursor },
  },
  snapshot: {
    type: 'snapshot',
    v: PROTOCOL_VERSION,
    sid: 'sid-1',
    rows: [{ id: 'p1', title: 'hello' }],
    cursor,
  },
  patch: {
    type: 'patch',
    v: PROTOCOL_VERSION,
    sid: 'sid-1',
    patches: [{ op: 'update', id: 'p1', row: { likes: 3 }, lsn: '000000000000000a' }],
    lsn: '000000000000000a',
  },
  mutate: {
    type: 'mutate',
    v: PROTOCOL_VERSION,
    key: 'toggleLike:p1',
    seq: 7,
    name: 'toggleLike',
    input: { postId: 'p1' },
  },
  ack: {
    type: 'ack',
    v: PROTOCOL_VERSION,
    ref: 'toggleLike:p1',
    lsn: '000000000000000b',
    error: null,
  },
  rebase: {
    type: 'rebase',
    v: PROTOCOL_VERSION,
    key: 'toggleLike:p1',
    entity: 'posts',
    strategy: 'server-wins',
    row: { id: 'p1', likes: 10 },
  },
  presence: {
    type: 'presence',
    v: PROTOCOL_VERSION,
    topic: 'org.o1.cursors',
    op: 'join',
    members: [{ id: 'm1', actorId: 'alice', meta: { x: 10, y: 4 }, updatedAt: 12 }],
  },
  reconnect: { type: 'reconnect', v: PROTOCOL_VERSION, afterMs: 4200, reason: 'drain' },
  'update-available': { type: 'update-available', v: PROTOCOL_VERSION, buildId: 'build-2' },
};

describe('sync-protocol', () => {
  test('every frame kind round-trips through encode/decode', () => {
    for (const kind of FRAME_KINDS) {
      const frame = fixtures[kind];
      expect(frame).toBeDefined();
      expect(decode(encode(frame))).toEqual(frame);
    }
  });

  test('FRAME_KINDS matches the union — a new frame without a fixture fails here', () => {
    expect([...FRAME_KINDS].sort()).toEqual(Object.keys(fixtures).sort() as FrameKind[]);
  });

  test('a mismatched protocol version is rejected, not coerced', () => {
    const stale = JSON.stringify({ ...fixtures.hello, v: PROTOCOL_VERSION + 1 });
    expect(() => decode(stale)).toThrow(ProtocolVersionError);
  });

  test('a malformed frame is rejected with the same code', () => {
    expect(() => decode(JSON.stringify({ type: 'patch', v: PROTOCOL_VERSION }))).toThrow(
      ProtocolVersionError,
    );
    expect(() => decode(JSON.stringify({ type: 'nope', v: PROTOCOL_VERSION }))).toThrow(
      ProtocolVersionError,
    );
    expect(() => decode('{not json')).toThrow(ProtocolVersionError);
  });

  test('decode accepts the binary form Bun hands a WS handler', () => {
    const bytes = new TextEncoder().encode(encode(fixtures.ack));
    expect(decode(bytes)).toEqual(fixtures.ack);
  });
});
