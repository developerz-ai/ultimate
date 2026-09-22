// The record store's own rules: one record per `type:key`; a server write merges and never clears
// a column; a bad row is dropped and reported, never merged; the last holder evicts; and the
// optimistic overlay is REPLAYED over server truth, taken back on refusal, and settled under the
// mutator's conflict policy with no flicker.

import { describe, expect, test } from 'bun:test';
import { type ConflictPolicy, type Row, UltimateError } from '@ultimat3/core';
import { RecordStore, recordKey } from './record-store';
import type { LocalTx } from './record-tx';

function store(): { store: RecordStore; reported: unknown[]; seen: ReadonlySet<string>[] } {
  const reported: unknown[] = [];
  const seen: ReadonlySet<string>[] = [];
  const created = new RecordStore({ report: (error) => reported.push(error) });
  created.subscribe((changed) => seen.push(changed));
  return { store: created, reported, seen };
}

const bump = (tx: LocalTx): void => {
  tx['posts']?.update('p1', (post) => ({ likes: Number(post['likes']) + 1 }));
};

describe('RecordStore — synced truth', () => {
  test('an HTTP adopt and a socket patch are one record, and a batch notifies once', () => {
    const { store: s, seen } = store();
    s.adopt('posts', { p1: { id: 'p1', title: 'hello', likes: 1 } });
    const fromHttp = s.peek('posts', 'p1');
    s.batch(() => {
      s.merge('posts', 'p1', { likes: 2 });
      s.merge('posts', 'p2', { id: 'p2', likes: 0 });
    });

    // A patch that omits `title` never clears it — another projection is rendering it.
    expect(s.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello', likes: 2 });
    expect(s.peek('posts', 'p1')).not.toBe(fromHttp);
    expect(seen).toHaveLength(2);
    expect([...(seen[1] ?? [])]).toEqual([recordKey('posts', 'p1'), recordKey('posts', 'p2')]);
  });

  test('two types with the same key are two records — a key alone is not an identity', () => {
    const { store: s } = store();
    s.adopt('posts', { '7': { title: 'a post' } });
    s.adopt('users', { '7': { email: 'a@b.c' } });
    expect(s.peek('posts', '7')).toEqual({ title: 'a post' });
    expect(s.peek('users', '7')).toEqual({ email: 'a@b.c' });
  });

  test('a write that changes nothing keeps the same object and notifies nobody', () => {
    const { store: s, seen } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const first = s.peek('posts', 'p1');
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    expect(s.peek('posts', 'p1')).toBe(first as Row);
    expect(seen).toHaveLength(1);
  });

  test('a structurally bad row is X_RECORD_REJECTED and dropped; its neighbours still land', () => {
    const { store: s, reported } = store();
    s.adopt('posts', {
      p1: 'not a row' as unknown as Row,
      p2: { id: 'p2', likes: 3 },
    });
    expect(s.peek('posts', 'p1')).toBeUndefined();
    expect(s.peek('posts', 'p2')).toEqual({ id: 'p2', likes: 3 });
    expect(reported).toHaveLength(1);
    expect(reported[0] instanceof UltimateError && reported[0].code).toBe('X_RECORD_REJECTED');
  });

  test('remove is gone for every holder at once', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1' } });
    s.remove('posts', ['p1']);
    expect(s.peek('posts', 'p1')).toBeUndefined();
  });

  test('the last holder leaving evicts the record; an earlier one does not', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1' } });
    s.retain('posts', 'p1');
    s.retain('posts', 'p1');
    s.release('posts', 'p1');
    expect(s.peek('posts', 'p1')).toBeDefined();
    s.release('posts', 'p1');
    expect(s.peek('posts', 'p1')).toBeUndefined();
  });
});

describe('RecordStore — the optimistic overlay', () => {
  test('a pushed write is visible at once and never touches synced truth', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
    s.drop('like:a');
    // Rolled back to exactly what the server said, not to a before-image taken at push time.
    expect(s.peek('posts', 'p1')?.['likes']).toBe(1);
  });

  test('two pending writes on one row replay in order OVER a server update', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    s.push('like:b', bump, 'server-wins');
    expect(s.peek('posts', 'p1')?.['likes']).toBe(3);

    // Someone else liked it: the server's 5 is the new base, and both pending writes ride on it.
    s.merge('posts', 'p1', { likes: 5 });
    expect(s.peek('posts', 'p1')?.['likes']).toBe(7);

    s.drop('like:a');
    expect(s.peek('posts', 'p1')?.['likes']).toBe(6);
  });

  test('settle after the answer was adopted drops the overlay with no flicker', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    // Convergent, as a mutator's twin must be: applying it over its own result is a no-op.
    const like = (tx: LocalTx): void => {
      tx['posts']?.update('p1', (post) =>
        post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
      );
    };
    s.push('like:a', like, 'server-wins');
    const shown: unknown[] = [];
    s.subscribe(() => shown.push(s.peek('posts', 'p1')?.['likes']));

    s.adopt('posts', { p1: { id: 'p1', likedByMe: true, likes: 2 } });
    s.settle('like:a');

    expect(s.peek('posts', 'p1')).toEqual({ id: 'p1', likedByMe: true, likes: 2 });
    expect(shown.every((likes) => likes === 2)).toBe(true);
    expect(s.pending()).toEqual([]);
  });

  test('a custom policy is CALLED at settle with the local row and the server row, in order', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const calls: [Row, Row][] = [];
    const policy: ConflictPolicy = {
      kind: 'custom',
      merge: (local, server) => {
        calls.push([local, server]);
        return { ...server, likes: Number(local['likes']) * 10 + Number(server['likes']) };
      },
    };
    s.push('edit:a', bump, policy);
    s.merge('posts', 'p1', { likes: 4 });
    s.settle('edit:a');

    // local = the twin replayed over the server's 4 = 5; server = 4. 54, never 45.
    expect(calls).toEqual([
      [
        { id: 'p1', likes: 5 },
        { id: 'p1', likes: 4 },
      ],
    ]);
    expect(s.peek('posts', 'p1')?.['likes']).toBe(54);
  });

  test('a server delete is not a conflict: no merge is called and the record is gone', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    let called = 0;
    s.push('edit:a', bump, {
      kind: 'custom',
      merge: (local) => {
        called += 1;
        return local;
      },
    });
    s.remove('posts', ['p1']);
    s.settle('edit:a');
    expect(called).toBe(0);
    expect(s.peek('posts', 'p1')).toBeUndefined();
  });

  test('last-write-wins with no clock on either side lets the server row stand', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('edit:a', bump, 'last-write-wins');
    s.merge('posts', 'p1', { likes: 4 });
    s.settle('edit:a');
    expect(s.peek('posts', 'p1')?.['likes']).toBe(4);
  });

  test('last-write-wins keeps the local row when it is newer by the server clock field', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1, updatedAt: 10 } });
    s.push(
      'edit:a',
      (tx) => tx['posts']?.update('p1', () => ({ likes: 9, updatedAt: 99 })),
      'last-write-wins',
    );
    s.merge('posts', 'p1', { likes: 4, updatedAt: 20 });
    s.settle('edit:a');
    expect(s.peek('posts', 'p1')).toEqual({ id: 'p1', likes: 9, updatedAt: 99 });
  });

  test('a custom merge answering no row is X_REBASE_CONFLICT, never a silent overwrite', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('edit:a', bump, {
      kind: 'custom',
      merge: () => 'nope' as unknown as Row,
    });
    expect(() => s.settle('edit:a')).toThrow(UltimateError);
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
  });

  test('a twin that throws on replay is dropped and reported, never half-applied', () => {
    const { store: s, reported } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push(
      'edit:a',
      (tx) => {
        tx['posts']?.update('p1', () => ({ likes: 100 }));
        if (Number(tx['posts']?.get('p1')?.['likes']) > 50) throw new TypeError('twin bug');
      },
      'server-wins',
    );
    expect(s.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(s.pending()).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  test('an optimistic insert takes its key explicitly, and clear() forgets every layer', () => {
    const { store: s } = store();
    s.push('new:a', (tx) => tx['posts']?.insert('p9', { id: 'p9', title: 'draft' }), 'server-wins');
    expect(s.peek('posts', 'p9')).toEqual({ id: 'p9', title: 'draft' });
    expect(s.all('posts')).toEqual([{ id: 'p9', title: 'draft' }]);
    s.clear();
    expect(s.peek('posts', 'p9')).toBeUndefined();
    expect(s.pending()).toEqual([]);
  });
});

describe('RecordStore — rows restored from disk', () => {
  test('restore fills only what the server has not answered, and the server row then REPLACES it', () => {
    const { store: s } = store();
    s.adopt('posts', { p2: { id: 'p2', title: 'from the server' } });
    s.restore('posts', {
      p1: { id: 'p1', title: 'stale', draft: true },
      p2: { id: 'p2', title: 'older copy' },
    });
    expect(s.peek('posts', 'p2')).toEqual({ id: 'p2', title: 'from the server' });
    expect(s.synced('posts', 'p1')).toEqual({ id: 'p1', title: 'stale', draft: true });

    // A merge would keep `draft`; a restored row is a guess, so the first server row wins outright.
    s.merge('posts', 'p1', { id: 'p1', title: 'fresh' });
    expect(s.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'fresh' });
    // Confirmed now: the next server write merges as usual.
    s.merge('posts', 'p1', { likes: 2 });
    expect(s.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'fresh', likes: 2 });
  });

  test('synced() is the server row alone — never the optimistic overlay', () => {
    const { store: s } = store();
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(s.synced('posts', 'p1')).toEqual({ id: 'p1', likes: 1 });
  });
});

describe('RecordStore — an answer that did not carry every row the write touched', () => {
  function manual(): { schedule: (fn: () => void, ms: number) => () => void; fire(): void } {
    let armed: (() => void) | null = null;
    return {
      schedule: (fn) => {
        armed = fn;
        return () => {
          armed = null;
        };
      },
      fire: () => armed?.(),
    };
  }

  test('keeps the overlay until the server row for it arrives — no flicker back', () => {
    const timer = manual();
    const s = new RecordStore({ schedule: timer.schedule });
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    // The action answered a VIEW: no `posts:p1` among its records.
    s.settle('like:a', new Set());
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);

    s.merge('posts', 'p1', { likes: 2 }); // the frame carrying the server's row
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(s.pending()).toEqual([]);
  });

  // The ordinary order, measured in the reference app: the node fans the commit out before the
  // HTTP response is written, so the frame beats the answer. Waiting for a SECOND server write
  // after that showed the write counted twice (the twin replayed over a row that already held it)
  // for the whole ten-second bound.
  test('a server row that landed while the write was in flight settles it at once', () => {
    const timer = manual();
    const s = new RecordStore({ schedule: timer.schedule });
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    s.merge('posts', 'p1', { likes: 2 }); // the channel frame, before the answer
    expect(s.peek('posts', 'p1')?.['likes']).toBe(3); // the twin replays over it meanwhile
    s.settle('like:a', new Set());
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(s.pending()).toEqual([]);
  });

  test('a server write to a row the write never touched does not settle it', () => {
    const timer = manual();
    const s = new RecordStore({ schedule: timer.schedule });
    s.adopt('posts', { p1: { id: 'p1', likes: 1 }, p2: { id: 'p2', likes: 5 } });
    s.push('like:a', bump, 'server-wins');
    s.merge('posts', 'p2', { likes: 6 });
    s.settle('like:a', new Set());
    expect(s.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(s.pending()).toEqual(['like:a']);
  });

  test('a row the answer DID carry settles at once', () => {
    const s = new RecordStore();
    s.adopt('posts', { p1: { id: 'p1', likes: 2 } });
    s.push('like:a', (tx) => tx['posts']?.update('p1', { seen: true }), 'server-wins');
    s.settle('like:a', new Set([recordKey('posts', 'p1')]));
    expect(s.pending()).toEqual([]);
  });

  test('the wait is bounded: when no row comes, the overlay goes and the synced layer stands', () => {
    const timer = manual();
    const s = new RecordStore({ schedule: timer.schedule });
    s.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    s.push('like:a', bump, 'server-wins');
    s.settle('like:a', new Set());
    timer.fire();
    expect(s.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(s.pending()).toEqual([]);
  });
});

describe('RecordStore — its one numeric option', () => {
  test('a non-finite or zero awaitMs is refused at construction, never a timer that fires at once', () => {
    for (const awaitMs of [Number.NaN, 0, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new RecordStore({ awaitMs })).toThrow(UltimateError);
    }
    expect(() => new RecordStore({ awaitMs: 5_000 })).not.toThrow();
  });
});
