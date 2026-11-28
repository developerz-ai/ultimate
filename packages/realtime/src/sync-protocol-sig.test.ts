// The `sig` a live cursor and a patch frame carry (#1280), as the decoder reads it: optional in
// both directions, and a PRESENT value that is no sig is never read as an absent one. Split from
// `sync-protocol.test.ts` at that file's size ceiling; the round-trip fixtures there carry a sig too.

import { describe, expect, test } from 'bun:test';
import { CURSOR_SIG_MALFORMED, CURSOR_SIG_MAX, wireSig } from './cursor';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const cursor = {
  qid: 'liveFeed:abcd1234',
  lsn: '0000000000000009',
  ids: ['p1', 'p2'],
  at: 1_700_000_000_000,
  sig: 'h1:0a1b2c3d:00112233445566778899aabbccddeeff',
};

const snapshot: Frame = {
  type: 'snapshot',
  v: PROTOCOL_VERSION,
  sid: 'sid-1',
  rows: [{ id: 'p1', title: 'hello' }],
  cursor,
};

const subscribe = {
  type: 'subscribe',
  v: PROTOCOL_VERSION,
  op: 'add',
  sid: 'sid-1',
  target: { kind: 'query', qid: 'liveFeed', input: { orgId: 'o1' }, cursor },
} as const satisfies Frame;

const patch = {
  type: 'patch',
  v: PROTOCOL_VERSION,
  sid: 'sid-1',
  patches: [{ op: 'update', id: 'p1', row: { likes: 3 }, lsn: '000000000000000a' }],
  lsn: '000000000000000a',
  sig: 'h1:0a1b2c3d:ffeeddccbbaa99887766554433221100',
} as const satisfies Frame;

describe("sync-protocol: a cursor's sig", () => {
  // #1280. Optional in both directions, so no version: a peer one deploy behind neither sends a
  // sig nor reads one. A PRESENT sig that is no sig is never read as an absent one — only the node
  // mints them, so it is kept as the one marker that verifies for nobody, and the frame is kept too.
  test('a sig rides a cursor and a patch, reads without one, and a malformed one stays present', () => {
    const { sig: _patchSig, ...unsignedPatch } = patch;
    const { sig: _cursorSig, ...unsignedCursor } = cursor;
    const unsignedSnapshot = { ...snapshot, cursor: unsignedCursor };
    // `unknown` in, because what is SENT may carry anything as its sig; a `Frame` out of `decode`.
    const withCursor = (held: unknown): unknown => ({
      ...subscribe,
      target: { ...subscribe.target, cursor: held },
    });
    const decoded = (sent: unknown): unknown => decode(JSON.stringify(sent));

    expect(decode(encode(patch))).toHaveProperty('sig', patch.sig);
    expect(decode(encode(snapshot))).toHaveProperty('cursor.sig', cursor.sig);
    expect(decode(encode(subscribe))).toHaveProperty('target.cursor.sig', cursor.sig);
    // What an older peer sends: no key at all, and none invented.
    expect(decode(JSON.stringify(unsignedPatch))).toEqual(unsignedPatch);
    expect(decode(JSON.stringify(unsignedSnapshot))).toEqual(unsignedSnapshot);
    expect(decoded(withCursor(unsignedCursor))).toEqual(withCursor(unsignedCursor));

    const marked = { ...unsignedCursor, sig: CURSOR_SIG_MALFORMED };
    const malformed = [
      7,
      null,
      '',
      {},
      ['h1'],
      'h'.repeat(CURSOR_SIG_MAX + 1),
      'h1:AB:cd',
      'h1:ab cd',
      'h1:\n',
      'NOT-A-SIG!',
    ];
    for (const sig of malformed) {
      expect(decode(JSON.stringify({ ...unsignedPatch, sig }))).toEqual({
        ...unsignedPatch,
        sig: CURSOR_SIG_MALFORMED,
      });
      expect(decoded({ ...unsignedSnapshot, cursor: { ...unsignedCursor, sig } })).toEqual({
        ...unsignedSnapshot,
        cursor: marked,
      });
      expect(decoded(withCursor({ ...unsignedCursor, sig }))).toEqual(withCursor(marked));
    }
    // The marker is not a sig a client can spell its way back to: sent as itself, it is itself.
    expect(wireSig(CURSOR_SIG_MALFORMED)).toBe(CURSOR_SIG_MALFORMED);
    expect(wireSig(undefined)).toBeUndefined();
    // The ceiling itself is readable: 64 characters of the sig alphabet.
    const longest = `h1:${'a'.repeat(61)}`;
    expect(decode(JSON.stringify({ ...unsignedPatch, sig: longest }))).toHaveProperty(
      'sig',
      longest,
    );
  });
});
