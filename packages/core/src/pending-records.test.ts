import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from './client-scope';
import type { RecordRows } from './record-envelope';
import type { RecordSink } from './record-sink';
import { pageClient, recordSink } from './record-sink';

const KEY = Symbol.for('ultimate.client');

afterEach(() => {
  Reflect.deleteProperty(globalThis, KEY);
  Reflect.deleteProperty(globalThis, 'document');
});

function recording(): RecordSink & {
  adopted: [string, RecordRows][];
  removed: [string, readonly string[]][];
} {
  const adopted: [string, RecordRows][] = [];
  const removed: [string, readonly string[]][] = [];
  return {
    adopted,
    removed,
    adopt: (type, rows) => adopted.push([type, rows]),
    remove: (type, keys) => removed.push([type, keys]),
  };
}

/** A browser page: the handle is created while a `document` exists. */
function browserPage(): void {
  // A handle another file left behind was created with no document; this page needs a fresh one.
  Reflect.deleteProperty(globalThis, KEY);
  Reflect.set(globalThis, 'document', { querySelector: () => null });
  pageClient();
}

describe('records answered before the store is installed', () => {
  test('in a browser they are held, latest row per key, and adopted once on install', () => {
    browserPage();
    const early = recordSink();
    early?.adopt('post', { p1: { id: 'p1', v: 1 }, p2: { id: 'p2', v: 1 } });
    early?.adopt('post', { p1: { id: 'p1', v: 2 } });
    early?.remove('post', ['p2', 'p9']);

    const store = recording();
    pageClient().store = store;

    expect(store.adopted).toEqual([['post', { p1: { id: 'p1', v: 2 } }]]);
    expect(store.removed).toEqual([['post', ['p2', 'p9']]]);
    // Once: a second install gets nothing more, and later records go straight to the store.
    const next = recording();
    pageClient().store = next;
    expect(next.adopted).toEqual([]);
    expect(recordSink()).toBe(next);
  });

  test('a key re-adopted after its removal is live again, not removed', () => {
    browserPage();
    recordSink()?.remove('post', ['p1']);
    recordSink()?.adopt('post', { p1: { id: 'p1' } });
    const store = recording();
    pageClient().store = store;
    expect(store.adopted).toEqual([['post', { p1: { id: 'p1' } }]]);
    expect(store.removed).toEqual([]);
  });

  test("a rescope forgets them: they were the previous principal's rows", () => {
    browserPage();
    recordSink()?.adopt('post', { p1: { id: 'p1' } });
    rescope('user:2');
    const store = recording();
    pageClient().store = store;
    expect(store.adopted).toEqual([]);
  });

  test('with no document (SSR, a server, a test) nothing is held', () => {
    Reflect.deleteProperty(globalThis, KEY);
    expect(recordSink()).toBeUndefined();
  });
});
