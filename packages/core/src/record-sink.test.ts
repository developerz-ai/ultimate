import { afterEach, describe, expect, test } from 'bun:test';
import { CLIENT_SCOPE_META } from './page-meta';
import type { RecordRows } from './record-envelope';
import type { RecordSink } from './record-sink';
import { pageClient } from './record-sink';

const KEY = Symbol.for('ultimate.client');

/** A distinct specifier is a distinct module evaluation — one per island bundle, reproduced. */
function copyOf(label: string): string {
  return `./record-sink.ts?copy=${label}`;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, KEY);
});

describe('pageClient', () => {
  test('two independently evaluated copies of the module resolve the SAME handle', async () => {
    // One island bundle, one copy of core: the per-island-store bug is exactly two evaluations.
    const first: { pageClient: typeof pageClient } = await import(copyOf('island-a'));
    const second: { pageClient: typeof pageClient } = await import(copyOf('island-b'));
    expect(first.pageClient).not.toBe(second.pageClient);
    expect(first.pageClient()).toBe(second.pageClient());
    expect(pageClient()).toBe(first.pageClient());
  });

  test('a store installed through one copy is the store every copy sees', async () => {
    const other: { pageClient: typeof pageClient } = await import(copyOf('store'));
    const adopted: [string, RecordRows][] = [];
    const sink: RecordSink = {
      adopt: (type, rows) => adopted.push([type, rows]),
      remove: () => {},
    };
    other.pageClient().store = sink;
    pageClient().store?.adopt('post', { p1: { id: 'p1' } });
    expect(adopted).toEqual([['post', { p1: { id: 'p1' } }]]);
  });

  test('starts empty and unscoped, and is not enumerable on globalThis', () => {
    const client = pageClient();
    expect(client.store).toBeUndefined();
    expect(client.socket).toBeUndefined();
    expect(client.scope).toEqual({ principal: undefined, epoch: 0 });
    expect(Object.getOwnPropertySymbols(globalThis)).toContain(KEY);
    expect(Object.getOwnPropertyDescriptor(globalThis, KEY)?.enumerable).toBe(false);
  });
});

describe('the rendered principal', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, KEY);
  });

  const withDocument = (content: string | undefined, run: () => void): void => {
    const doc = {
      querySelector: (selector: string) =>
        selector === 'meta[name="ultimate-scope"]' && content !== undefined ? { content } : null,
    };
    Reflect.set(globalThis, 'document', doc);
    try {
      run();
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  };

  test('is read from the ultimate-scope meta when the handle is created', () => {
    withDocument('user:7', () => {
      expect(pageClient().scope).toEqual({ principal: 'user:7', epoch: 0 });
    });
  });

  test('an empty meta is the anonymous visitor', () => {
    withDocument('', () => expect(pageClient().scope).toEqual({ principal: null, epoch: 0 }));
  });

  test('no meta is an UNSCOPED page — rendered for nobody, never read as anonymous', () => {
    withDocument(undefined, () => {
      expect(pageClient().scope).toEqual({ principal: undefined, epoch: 0 });
    });
  });

  test('no document at all is unscoped too', () => {
    expect(pageClient().scope.principal).toBeUndefined();
  });

  test('the meta name is the one render writes', () => {
    expect(CLIENT_SCOPE_META).toBe('ultimate-scope');
  });
});
