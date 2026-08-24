import { describe, expect, test } from 'bun:test';
import { ProtocolVersionError } from './errors';
import {
  decode,
  encode,
  FRAME_KINDS,
  FRAME_LIMITS,
  type Frame,
  type FrameKind,
  PROTOCOL_VERSION,
  toWireError,
  type WireError,
} from './sync-protocol';

const cursor = {
  qid: 'liveFeed:abcd1234',
  lsn: '0000000000000009',
  ids: ['p1', 'p2'],
  at: 1_700_000_000_000,
};

const fixtures: Record<FrameKind, Frame> = {
  hello: {
    type: 'hello',
    v: PROTOCOL_VERSION,
    buildId: 'build-1',
    sessionId: null,
    actorId: 'alice',
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

  /**
   * **2, not 1** — moved when `cursor.digest` and `cursor.count` were deleted (2026-08-24). The
   * reason is the DECODER, not the deletion: `hello.resume` came out at the same version because
   * `list()` answers `[]` for an absent field, while `cursor()` reads through `str`/`num`, which
   * THROW. So a snapshot cursor this node writes is unreadable by a client one deploy behind, and
   * a subscribe cursor a new client writes is unreadable by a node one deploy behind — a frame
   * unreadable in both directions, which is the one thing the version guards. A change that is
   * genuinely additive or drops a field read through `list()` still must not move this number.
   */
  test('the wire is at version 2, and the number is not moved for novelty', () => {
    expect(PROTOCOL_VERSION).toBe(2);
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

  /**
   * `hello.resume` was written by every client and read by nothing: the node answered `resume: []`
   * and decided resume per subscription off the `subscribe` frame instead, so a reconnect shipped
   * each cursor twice. Removing it is only safe while a client one deploy behind still decodes —
   * the whitelist is what makes that true, and this is the test that says so. Re-adding a `resume`
   * to the hello case fails on `'resume' in decoded`.
   */
  test('a hello from a client one deploy behind decodes, and its resume list is dropped', () => {
    const legacy = JSON.stringify({ ...fixtures.hello, resume: [cursor] });
    const decoded = decode(legacy);
    expect(decoded).toEqual(fixtures.hello);
    expect('resume' in decoded).toBe(false);
  });

  /**
   * `cursor.digest` and `cursor.count` were written on every snapshot and read by nothing. The
   * whitelist is what makes an EXTRA field harmless, and this is the test that says so — a
   * `digest:` put back into `cursor()` fails on `'digest' in target.cursor`.
   *
   * It is deliberately written at the CURRENT version, not at the previous one: `str`/`num` throw
   * on an absent field where `list` answers `[]`, so a new node's snapshot cursor is unreadable by
   * a client one deploy behind. That is what moved `PROTOCOL_VERSION` — see the version test above.
   */
  test('a cursor carrying the removed digest and count decodes, and drops both', () => {
    const legacy = JSON.stringify({
      ...fixtures.subscribe,
      target: {
        kind: 'query',
        qid: 'liveFeed',
        input: { orgId: 'o1' },
        cursor: { ...cursor, digest: 'deadbeef', count: 2 },
      },
    });
    const decoded = decode(legacy);
    expect(decoded).toEqual(fixtures.subscribe);
    const target = (decoded as Extract<Frame, { type: 'subscribe' }>).target;
    expect(target.kind).toBe('query');
    if (target.kind !== 'query') expect.unreachable();
    expect(target.cursor === null ? [] : Object.keys(target.cursor).sort()).toEqual([
      'at',
      'ids',
      'lsn',
      'qid',
    ]);
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

/**
 * Every array and every nested value one authenticated socket can put on the wire. The decoder
 * enforced no size at all: a `cursor.ids` of ten million strings was consumed raw by
 * `live-query.ts` (`new Set(args.cursor.ids)`), and `input` of arbitrary depth reached
 * `canonicalJson`, which is recursive — a stack overflow on the frame path, in the process, from
 * one frame.
 */
describe('the decoder refuses what it cannot afford', () => {
  const cursorOf = (ids: readonly string[]): Record<string, unknown> => ({
    qid: 'q1',
    lsn: '1',
    ids,
    at: 0,
  });

  test('a cursor carrying more ids than a cursor can hold is refused by code', () => {
    const ids = Array.from({ length: FRAME_LIMITS.cursorIds + 1 }, (_, i) => `row-${i}`);
    const frame = JSON.stringify({
      ...fixtures.subscribe,
      target: { kind: 'query', qid: 'feed', input: null, cursor: cursorOf(ids) },
    });
    expect(() => decode(frame)).toThrow(ProtocolVersionError);
    expect(() => decode(frame)).toThrow(/cursor\.ids/);
    // The limit the server itself writes still decodes: a cap below what this node produces
    // would refuse its own cursors on the next reconnect.
    const atLimit = Array.from({ length: FRAME_LIMITS.cursorIds }, (_, i) => `row-${i}`);
    expect(() =>
      decode(
        JSON.stringify({
          ...fixtures.subscribe,
          target: { kind: 'query', qid: 'feed', input: null, cursor: cursorOf(atLimit) },
        }),
      ),
    ).not.toThrow();
  });

  test('an oversized patch list and row list are each refused', () => {
    const many = (length: number, value: unknown): unknown[] => Array.from({ length }, () => value);
    expect(() =>
      decode(
        JSON.stringify({
          ...fixtures.patch,
          patches: many(FRAME_LIMITS.patches + 1, { op: 'insert', id: 'p1', row: {}, lsn: '1' }),
        }),
      ),
    ).toThrow(/patches/);
    expect(() =>
      decode(
        JSON.stringify({ ...fixtures.snapshot, rows: many(FRAME_LIMITS.rows + 1, { id: 'p1' }) }),
      ),
    ).toThrow(/rows/);
  });

  test('a deeply nested input is refused by code, not by a stack overflow', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < FRAME_LIMITS.inputDepth + 5; i += 1) deep = { next: deep };
    const frame = JSON.stringify({ ...fixtures.mutate, input: deep });
    expect(() => decode(frame)).toThrow(ProtocolVersionError);
    expect(() => decode(frame)).toThrow(/nested/);
  });

  test('a wide input is refused by the same walk', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i <= FRAME_LIMITS.inputNodes; i += 1) wide[`k${i}`] = i;
    expect(() =>
      decode(
        JSON.stringify({
          ...fixtures.subscribe,
          target: { kind: 'query', qid: 'feed', input: wide, cursor: null },
        }),
      ),
    ).toThrow(ProtocolVersionError);
  });

  test('an input a real client sends still decodes unchanged', () => {
    const input = { orgId: 'o1', filter: { tags: ['a', 'b'], since: { lsn: '7' } } };
    const decoded = decode(
      JSON.stringify({
        ...fixtures.subscribe,
        target: { kind: 'query', qid: 'feed', input, cursor: null },
      }),
    );
    expect(
      decoded.type === 'subscribe' && decoded.target.kind === 'query' && decoded.target.input,
    ).toEqual(input);
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
