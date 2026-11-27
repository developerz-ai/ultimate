// The signature a live cursor carries: what it binds (the window, the position, the ids, the
// subscriber), what it leaves free (`at`, the id order), and what each tampering reads as. The
// registry-level consequences are `live-resume-signed.test.ts`'s.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no path API; the import walk resolves relative specifiers against this directory.
import { join } from 'node:path';
import { configureCursorSigning, resetCursorSigning, userActor } from '@ultimat3/core';
import { CURSOR_SIG_MAX, type LiveCursor } from './cursor';
import { CursorTrust, cursorVerdict, signCursor } from './cursor-sign';
import type { Subscriber } from './subscriber-gate';

afterEach(() => resetCursorSigning());

const alice: Subscriber = { sid: 'a1', actor: userActor({ id: 'alice', orgId: 'o1' }) };
const bob: Subscriber = { sid: 'b1', actor: userActor({ id: 'bob', orgId: 'o1' }) };
const anonymous: Subscriber = { sid: 'n1', actor: null };

const cursor: LiveCursor = { qid: 'q1', lsn: '0002', ids: ['p1', 'p2'], at: 1_000 };

describe('signCursor', () => {
  test('a signed cursor verifies for the subscriber it was minted for', () => {
    const signed = signCursor(cursor, alice);
    expect(signed.sig.length).toBeLessThanOrEqual(CURSOR_SIG_MAX);
    expect(signed).toEqual({ ...cursor, sig: signed.sig });
    expect(cursorVerdict(signed, alice)).toBe('signed');
  });

  test('the sid is not bound: a reconnect subscribes under a new one', () => {
    const signed = signCursor(cursor, alice);
    expect(cursorVerdict(signed, { ...alice, sid: 'another-sid' })).toBe('signed');
  });

  test('`at` is the client clock and is not bound; the id ORDER is not either', () => {
    const signed = signCursor(cursor, alice);
    expect(cursorVerdict({ ...signed, at: 9_999_999 }, alice)).toBe('signed');
    expect(cursorVerdict({ ...signed, ids: ['p2', 'p1'] }, alice)).toBe('signed');
  });

  test('a cursor with no sig is unsigned, never refused', () => {
    expect(cursorVerdict(cursor, alice)).toBe('unsigned');
  });
});

describe('a signature that does not match is refused', () => {
  const signed = signCursor(cursor, alice);

  test.each([
    ['a superset of the ids', { ...signed, ids: ['p1', 'p2', 'p3'] }],
    ['a subset of the ids', { ...signed, ids: ['p1'] }],
    ['another id of the same length', { ...signed, ids: ['p1', 'p9'] }],
    ['a duplicated id', { ...signed, ids: ['p1', 'p2', 'p2'] }],
    ['an lsn rolled back', { ...signed, lsn: '0001' }],
    ['an lsn rolled forward', { ...signed, lsn: '0003' }],
    ['another window', { ...signed, qid: 'q2' }],
    ['a truncated sig', { ...signed, sig: signed.sig.slice(0, -1) }],
    ['an empty sig', { ...signed, sig: '' }],
    ['a sig in no format this build mints', { ...signed, sig: 'deadbeef' }],
  ])('%s', (_label, forged) => {
    expect(cursorVerdict(forged, alice)).toBe('refused');
  });

  test("another subscriber's sig, replayed", () => {
    expect(cursorVerdict(signed, bob)).toBe('refused');
    expect(cursorVerdict(signed, anonymous)).toBe('refused');
  });

  test("an anonymous subscriber's sig is no signed-in actor's, whatever its id spells", () => {
    const open = signCursor(cursor, anonymous);
    expect(cursorVerdict(open, anonymous)).toBe('signed');
    expect(cursorVerdict(open, alice)).toBe('refused');
    // In no org, as the anonymous subject is: the actor is then the only thing that differs.
    for (const id of ['alice', 'null', '']) {
      const named: Subscriber = { sid: 'x1', actor: userActor({ id }) };
      expect(cursorVerdict(open, named)).toBe('refused');
    }
  });

  test('the same actor id in another tenant', () => {
    const elsewhere: Subscriber = { sid: 'a1', actor: userActor({ id: 'alice', orgId: 'o2' }) };
    expect(cursorVerdict(signed, elsewhere)).toBe('refused');
  });

  test('ids that only JOIN to the same text are another list', () => {
    const joined = signCursor({ ...cursor, ids: ['a,b'] }, alice);
    expect(cursorVerdict({ ...joined, ids: ['a', 'b'] }, alice)).toBe('refused');
    const quoted = signCursor({ ...cursor, ids: ['a","b'] }, alice);
    expect(cursorVerdict({ ...quoted, ids: ['a', 'b'] }, alice)).toBe('refused');
  });

  test('a sig minted under a rotated secret is refused, not trusted', () => {
    configureCursorSigning('secret-before-rotation-0123456789abcdef');
    const before = signCursor(cursor, alice);
    configureCursorSigning('secret-after-rotation-fedcba9876543210');
    expect(cursorVerdict(before, alice)).toBe('refused');
  });
});

describe('the ids digest is cached by array identity', () => {
  test('a mutated copy is never answered from the cache of the array it was copied from', () => {
    const signed = signCursor(cursor, alice);
    const again = signCursor({ ...cursor, lsn: '0003' }, alice);
    expect(again.sig).not.toBe(signed.sig);
    expect(cursorVerdict({ ...again, ids: [...cursor.ids, 'p3'] }, alice)).toBe('refused');
    expect(cursorVerdict({ ...again, ids: [...cursor.ids] }, alice)).toBe('signed');
  });
});

describe('CursorTrust', () => {
  test('counts and reports an unsigned cursor, and resumes it', () => {
    const seen: unknown[] = [];
    const trust = new CursorTrust({ onUnsignedCursor: (event) => seen.push(event) });
    expect(trust.admits(cursor, alice)).toBe(true);
    expect(trust.unsignedCursors).toBe(1);
    expect(trust.cursorsRefused).toBe(0);
    expect(seen).toEqual([{ qid: 'q1', sid: 'a1', actorId: 'alice' }]);
  });

  test('counts and reports a refused cursor, and does not resume it', () => {
    const seen: unknown[] = [];
    const trust = new CursorTrust({ onCursorRefused: (event) => seen.push(event) });
    const forged = { ...signCursor(cursor, alice), ids: ['p1', 'p2', 'p3'] };
    expect(trust.admits(forged, alice)).toBe(false);
    expect(trust.cursorsRefused).toBe(1);
    expect(trust.unsignedCursors).toBe(0);
    expect(seen).toEqual([{ qid: 'q1', sid: 'a1', actorId: 'alice' }]);
  });

  test('a signed cursor is admitted and counted nowhere', () => {
    const trust = new CursorTrust({});
    expect(trust.admits(signCursor(cursor, alice), alice)).toBe(true);
    expect([trust.unsignedCursors, trust.cursorsRefused]).toEqual([0, 0]);
  });
});

/** Every module reachable from `entry` through relative imports, type-only ones excluded. */
async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await Bun.file(join(import.meta.dir, `${file}.ts`)).text();
    for (const found of transpiler.scanImports(source)) {
      if (found.path.startsWith('./')) queue.push(found.path.slice(2));
    }
  }
  return seen;
}

describe('signing stays out of the page graph', () => {
  // The browser's half of this package, and the two files a cursor passes through on a page.
  test.each(['index', 'cursor', 'sync-protocol', 'client-frames'])(
    '%s.ts never reaches cursor-sign.ts',
    async (entry) => {
      const modules = await reachable(entry);
      expect(modules.has('cursor')).toBe(true);
      expect(modules.has('cursor-sign')).toBe(false);
    },
  );

  test('the walk sees a server module that does import it', async () => {
    expect((await reachable('live-query')).has('cursor-sign')).toBe(true);
  });
});
