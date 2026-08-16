import { describe, expect, test } from 'bun:test';
import { ProtocolVersionError } from './errors';
import {
  decode,
  encode,
  FRAME_KINDS,
  type Frame,
  type FrameKind,
  PROTOCOL_VERSION,
  toWireError,
  type WireError,
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
    entity: 'posts',
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
    key: 'likePost:p1',
    seq: 7,
    name: 'likePost',
    input: { postId: 'p1' },
  },
  ack: {
    type: 'ack',
    v: PROTOCOL_VERSION,
    ref: 'likePost:p1',
    lsn: '000000000000000b',
    error: null,
  },
  rebase: {
    type: 'rebase',
    v: PROTOCOL_VERSION,
    key: 'likePost:p1',
    entity: 'posts',
    strategy: 'server-wins',
    row: { id: 'p1', likes: 10 },
  },
  presence: {
    type: 'presence',
    v: PROTOCOL_VERSION,
    topic: 'org.o1.cursors',
    op: 'sync',
    members: [{ id: 'm1', actorId: 'alice', meta: { x: 10, y: 4 }, updatedAt: 12 }],
    total: 5_000,
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

  /**
   * `entity` is additive: it is the client's identity scope, and a node that predates it simply
   * omits it. Refusing such a frame would be a protocol break for a field whose absence has a
   * defined meaning — the subscription keeps its rows private — so both spellings must decode.
   */
  test('a snapshot without an entity decodes, and does not invent one', () => {
    const { entity, ...withoutEntity } = fixtures.snapshot as Extract<Frame, { type: 'snapshot' }>;
    expect(entity).toBe('posts');
    const decoded = decode(JSON.stringify(withoutEntity));
    expect(decoded).toEqual(withoutEntity);
    expect('entity' in decoded).toBe(false);
  });

  test('a non-string entity is a malformed frame, never a scope the client would key rows by', () => {
    const bad = JSON.stringify({ ...fixtures.snapshot, entity: 7 });
    expect(() => decode(bad)).toThrow(ProtocolVersionError);
  });

  /**
   * `total` is the same additive shape as `snapshot.entity`, one frame over: a full-set presence
   * frame is capped, and the count is what lets a client render "and 4,744 others". A delta op
   * carries no count at all, so its absence has to survive the round trip as an absence.
   */
  test('a presence frame without a total decodes, and does not invent one', () => {
    const { total, ...withoutTotal } = fixtures.presence as Extract<Frame, { type: 'presence' }>;
    expect(total).toBe(5_000);
    const decoded = decode(JSON.stringify(withoutTotal));
    expect(decoded).toEqual(withoutTotal);
    expect('total' in decoded).toBe(false);
  });

  test('a non-numeric presence total is a malformed frame, never a count a UI would render', () => {
    expect(() => decode(JSON.stringify({ ...fixtures.presence, total: 'lots' }))).toThrow(
      ProtocolVersionError,
    );
  });

  test('decode accepts the binary form Bun hands a WS handler', () => {
    const bytes = new TextEncoder().encode(encode(fixtures.ack));
    expect(decode(bytes)).toEqual(fixtures.ack);
  });
});

// `toWireError` is how `sync-node.ts` answers a socket for anything a mutator, a live query or a
// policy threw — app code, so an app value. `String()` runs the value's own `toString`, and the
// throw it raises escapes the handler's catch: the client is left waiting on a frame the node
// never sent, which a reconnect cannot repair because the mutation throws again.
describe('toWireError over a throwable it does not control', () => {
  const hostile = (): ReadonlyMap<string, unknown> =>
    new Map<string, unknown>([
      [
        'a hostile toString',
        {
          toString: () => {
            throw new Error('gotcha');
          },
        },
      ],
      ['a null-prototype object', Object.create(null)],
    ]);

  for (const [label, value] of hostile()) {
    test(`still projects a three-field wire error for ${label}`, () => {
      let wire: WireError | undefined;
      expect(() => {
        wire = toWireError(value);
      }).not.toThrow();
      expect(wire?.code).toBe('X_PROTOCOL_VERSION');
      expect(wire?.fix).toBe('x doctor realtime');
      expect(wire?.cause.length).toBeGreaterThan(0);
    });
  }

  test('a throwable whose fields throw when read still gets a frame', () => {
    // The PROBE was the unguarded read, not the render: `typeof shape?.code === 'string'` calls a
    // getter on a mutator's value, so the socket got nothing for a reason no fallback could catch.
    const trapped = new Proxy(new Error('boom'), {
      get: () => {
        throw new Error('gotcha');
      },
    });

    const wire = toWireError(trapped);
    expect(wire.code).toBe('X_PROTOCOL_VERSION');
    expect(wire.fix).toBe('x doctor realtime');
    expect(wire.cause.length).toBeGreaterThan(0);
  });

  test('a throwable carrying the contract keeps every field it named', () => {
    expect(
      toWireError({ code: 'X_TOPIC_FORBIDDEN', cause: 'no guard', fix: 'declare one' }),
    ).toEqual({ code: 'X_TOPIC_FORBIDDEN', cause: 'no guard', fix: 'declare one' });
  });
});
