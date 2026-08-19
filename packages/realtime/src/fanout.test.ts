/**
 * The single-node transport and the subject grammar every other one has to match. `x dev`, the
 * tests and a small deployment all run on this, so its close/publish contract is the one the
 * NATS transport is held to — not a convenience double.
 */

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { InProcessTransport, subjectMatches } from './fanout';

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not an UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

describe('subjectMatches', () => {
  test('* matches exactly one token and > matches one-or-more trailing tokens', () => {
    expect(subjectMatches('x.change.posts.org-1', 'x.change.posts.org-1')).toBe(true);
    expect(subjectMatches('x.change.*.org-1', 'x.change.posts.org-1')).toBe(true);
    expect(subjectMatches('x.change.*', 'x.change.posts.org-1')).toBe(false);
    expect(subjectMatches('x.change.>', 'x.change.posts.org-1')).toBe(true);
    expect(subjectMatches('x.change.>', 'x.change')).toBe(false);
    expect(subjectMatches('x.change.posts', 'x.change')).toBe(false);
    expect(subjectMatches('x.change', 'x.change.posts')).toBe(false);
  });
});

describe('InProcessTransport', () => {
  test('delivers to every matching subscriber and to no other subject', async () => {
    const transport = new InProcessTransport();
    const posts: string[] = [];
    const wildcard: string[] = [];
    const other: string[] = [];
    await transport.subscribe('x.change.posts.org-1', (payload) => posts.push(payload));
    await transport.subscribe('x.change.>', (payload) => wildcard.push(payload));
    await transport.subscribe('x.change.users.org-1', (payload) => other.push(payload));

    await transport.publish('x.change.posts.org-1', 'p1');

    expect(posts).toEqual(['p1']);
    expect(wildcard).toEqual(['p1']);
    expect(other).toEqual([]);
  });

  test('subjectCount tracks live subjects, and unsubscribe drops the subject with its last handler', async () => {
    const transport = new InProcessTransport();
    expect(transport.subjectCount).toBe(0);

    const first = await transport.subscribe('x.change.posts.org-1', () => {});
    const second = await transport.subscribe('x.change.posts.org-1', () => {});
    await transport.subscribe('x.change.users.org-1', () => {});
    expect(transport.subjectCount).toBe(2);

    // One of two handlers leaving keeps the subject: the OTHER subscriber still wants it.
    first.unsubscribe();
    expect(transport.subjectCount).toBe(2);
    second.unsubscribe();
    expect(transport.subjectCount).toBe(1);
    // Idempotent: a second unsubscribe is not an error and does not remove a sibling.
    second.unsubscribe();
    expect(transport.subjectCount).toBe(1);
  });

  test('close drops every subscription and refuses both doors with X_TRANSPORT_UNAVAILABLE', async () => {
    const transport = new InProcessTransport();
    const seen: string[] = [];
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));
    await transport.publish('x.change.posts.org-1', 'before');

    await transport.close();

    expect(transport.subjectCount).toBe(0);
    expect(await codeOf(() => transport.publish('x.change.posts.org-1', 'after'))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    expect(await codeOf(() => transport.subscribe('x.change.>', () => {}))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    // The handler registered before the close is not called after it.
    expect(seen).toEqual(['before']);
  });

  test('close is idempotent, so a second shutdown is not a second failure mode', async () => {
    const transport = new InProcessTransport();
    await transport.close();
    await transport.close();
    expect(await codeOf(() => transport.publish('x.change.posts.org-1', 'x'))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
  });

  test('a throwing subscriber is reported and the rest still receive the message', async () => {
    const errors: string[] = [];
    const transport = new InProcessTransport({
      onError: (error, subject) => errors.push(`${subject}:${String(error)}`),
    });
    const seen: string[] = [];
    await transport.subscribe('x.change.>', () => {
      throw new Error('subscriber blew up');
    });
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));

    await transport.publish('x.change.posts.org-1', 'p1');

    expect(seen).toEqual(['p1']);
    expect(errors).toEqual(['x.change.posts.org-1:Error: subscriber blew up']);
  });

  test('with no onError a throwing subscriber is still not fatal to the others', async () => {
    const transport = new InProcessTransport();
    const seen: string[] = [];
    await transport.subscribe('x.change.>', () => {
      throw new Error('subscriber blew up');
    });
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));

    await expect(transport.publish('x.change.posts.org-1', 'p1')).resolves.toBeUndefined();
    expect(seen).toEqual(['p1']);
  });
});

describe('InProcessTransport.shared — the TTL set presence is built on', () => {
  test('an entry expires on its own, and entries() stops reporting it', async () => {
    const clock = frozenClock('2026-03-14T09:00:00Z');
    const transport = new InProcessTransport({ clock });
    await transport.shared.put('room:1', 'ada', 'online', 1_000);

    expect(await transport.shared.entries('room:1')).toEqual([
      { member: 'ada', value: 'online', expiresAt: clock.now().getTime() + 1_000 },
    ]);
    clock.advance(1_001);
    expect(await transport.shared.entries('room:1')).toEqual([]);
  });

  test('touch extends a live member and refuses an expired one, which is a re-join', async () => {
    const clock = frozenClock('2026-03-14T09:00:00Z');
    const transport = new InProcessTransport({ clock });
    await transport.shared.put('room:1', 'ada', 'online', 1_000);

    clock.advance(500);
    expect(await transport.shared.touch('room:1', 'ada', 1_000)).toBe(true);
    // The extension is from NOW, not from the original deadline.
    clock.advance(900);
    expect((await transport.shared.entries('room:1')).map((e) => e.member)).toEqual(['ada']);

    clock.advance(1_000);
    expect(await transport.shared.touch('room:1', 'ada', 1_000)).toBe(false);
    expect(await transport.shared.touch('room:1', 'unknown', 1_000)).toBe(false);
    expect(await transport.shared.touch('room:404', 'ada', 1_000)).toBe(false);
  });

  test('drop removes the member, and the key with its last one', async () => {
    const clock = frozenClock('2026-03-14T09:00:00Z');
    const transport = new InProcessTransport({ clock });
    await transport.shared.put('room:1', 'ada', 'online', 1_000);
    await transport.shared.put('room:1', 'bob', 'online', 1_000);

    await transport.shared.drop('room:1', 'ada');
    expect((await transport.shared.entries('room:1')).map((e) => e.member)).toEqual(['bob']);

    await transport.shared.drop('room:1', 'bob');
    expect(await transport.shared.entries('room:1')).toEqual([]);
    // A key that never existed is not an error either.
    await expect(transport.shared.drop('room:404', 'ada')).resolves.toBeUndefined();
  });

  test('an unknown key is an empty roster, never undefined', async () => {
    const transport = new InProcessTransport({ clock: frozenClock('2026-03-14T09:00:00Z') });
    expect(await transport.shared.entries('room:404')).toEqual([]);
  });
});
