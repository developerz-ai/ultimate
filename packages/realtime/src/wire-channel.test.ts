// A record type, a record key and a channel param are DATA: a frame naming one `__proto__` must
// carry it as a key, never lose it into the prototype of the map that holds it.

import { describe, expect, test } from 'bun:test';
import { decode } from './sync-protocol';
import { PROTOCOL_VERSION } from './wire-version';

const frame = (body: string): string =>
  `{"type":"records","v":${String(PROTOCOL_VERSION)},"channel":"org-feed.o1","seq":1,"epoch":"e1",${body}}`;

describe('decoding channel frames keyed by a prototype name', () => {
  test('adopt keeps a record TYPE named __proto__', () => {
    const decoded = decode(
      frame('"adopt":{"__proto__":{"p1":{"id":"p1"}},"posts":{"p2":{"id":"p2"}}}'),
    );
    if (decoded.type !== 'records') return expect.unreachable('not a records frame');
    expect(Object.keys(decoded.adopt ?? {})).toEqual(['__proto__', 'posts']);
    expect(Object.entries(decoded.adopt ?? {})[0]?.[1]).toEqual({ p1: { id: 'p1' } });
  });

  test('adopt keeps a record KEY named __proto__', () => {
    const decoded = decode(frame('"adopt":{"posts":{"__proto__":{"id":"x"},"p2":{"id":"p2"}}}'));
    if (decoded.type !== 'records') return expect.unreachable('not a records frame');
    const posts = Object.entries(decoded.adopt ?? {})[0]?.[1] ?? {};
    expect(Object.keys(posts)).toEqual(['__proto__', 'p2']);
    expect(Object.getPrototypeOf(posts)).toBeNull();
  });

  test('remove keeps a record TYPE named __proto__', () => {
    const decoded = decode(frame('"remove":{"__proto__":["p1"],"posts":["p2"]}'));
    if (decoded.type !== 'records') return expect.unreachable('not a records frame');
    expect(Object.keys(decoded.remove ?? {})).toEqual(['__proto__', 'posts']);
    expect(Object.entries(decoded.remove ?? {})[0]?.[1]).toEqual(['p1']);
  });

  test('a channel subscribe keeps a PARAM named __proto__', () => {
    const decoded = decode(
      `{"type":"subscribe","v":${String(PROTOCOL_VERSION)},"op":"add","sid":"channel:t","target":{"kind":"channel","channel":"org-feed","params":{"__proto__":"x","orgId":"o1"}}}`,
    );
    if (decoded.type !== 'subscribe' || decoded.target.kind !== 'channel') {
      return expect.unreachable('not a channel subscribe');
    }
    expect(Object.keys(decoded.target.params)).toEqual(['__proto__', 'orgId']);
  });
});
