// The emitted background-sync block is code nobody type-checks: it leaves this package as a
// string and is next parsed by a browser. So these tests RUN it, in a stand-in worker realm,
// rather than trusting that it was spelled right.

import { describe, expect, test } from 'bun:test';
import { OUTBOX_DRAIN_MESSAGE } from '@ultimat3/core';
import { backgroundSyncSource, registerBackgroundSyncSource, SYNC_TAG } from './background-sync';

interface SyncEvent {
  readonly tag: string;
  waitUntil(work: Promise<unknown>): void;
}

/** Evaluates the block with a fake `self`, and fires one `sync` event at it. */
async function fireSync(tag: string, openTabs: number): Promise<unknown[][]> {
  const posted: unknown[][] = Array.from({ length: openTabs }, () => []);
  let listener: ((event: SyncEvent) => void) | undefined;
  const self = {
    clients: {
      matchAll: async () =>
        posted.map((inbox) => ({ postMessage: (data: unknown): number => inbox.push(data) })),
    },
    addEventListener: (type: string, handler: (event: SyncEvent) => void): void => {
      if (type === 'sync') listener = handler;
    },
  };
  new Function('self', backgroundSyncSource())(self);
  const pending: Promise<unknown>[] = [];
  listener?.({ tag, waitUntil: (work) => pending.push(work) });
  await Promise.all(pending);
  return posted;
}

describe('backgroundSyncSource, executed', () => {
  test('a sync on this package tag tells EVERY open tab to drain its outbox', async () => {
    const posted = await fireSync(SYNC_TAG, 2);
    expect(posted).toEqual([[{ type: OUTBOX_DRAIN_MESSAGE }], [{ type: OUTBOX_DRAIN_MESSAGE }]]);
  });

  test('a sync on another tag is not ours and posts nothing', async () => {
    expect(await fireSync('someone-else', 1)).toEqual([[]]);
  });

  test('with no tab open it resolves — the queue drains on the next load, nothing is faked', async () => {
    expect(await fireSync(SYNC_TAG, 0)).toEqual([]);
  });

  test('sends nothing over the network: the outbox lives in the page, not the worker', () => {
    const source = backgroundSyncSource();
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('/_x/outbox/flush');
  });

  // Periodic Background Sync is NOT implemented, and this is where that is written down.
  test('one-shot sync only — no periodicsync handler is emitted, because none is implemented', () => {
    const source = backgroundSyncSource();
    expect(source).toContain("addEventListener('sync'");
    expect(source).not.toContain('periodicsync');
    expect(registerBackgroundSyncSource()).not.toContain('periodicSync');
  });

  test('is deterministic for identical input', () => {
    expect(backgroundSyncSource()).toBe(backgroundSyncSource());
  });
});

/**
 * `registerBackgroundSyncSource` is client code emitted as a string, so it is executed rather than
 * read. The fallback branch is the one that matters: without it, every browser without Background
 * Sync keeps its outbox forever and the user's mutations never leave the device.
 */
describe('registerBackgroundSyncSource, executed', () => {
  interface Realm {
    readonly registered: string[];
    readonly online: (() => void)[];
    readonly posted: unknown[];
    register(registration: unknown): Promise<string>;
  }

  function realm(): Realm {
    const registered: string[] = [];
    const online: (() => void)[] = [];
    const posted: unknown[] = [];
    const source = registerBackgroundSyncSource();
    expect(source.startsWith('export async function registerOutboxSync')).toBe(true);

    const run = new Function(
      'addEventListener',
      'navigator',
      'registration',
      `${source.replace('export async function', 'async function')}
return registerOutboxSync(registration);`,
    ) as (
      addEventListener: (type: string, handler: () => void) => void,
      navigator: unknown,
      registration: unknown,
    ) => Promise<string>;

    return {
      registered,
      online,
      posted,
      register: (registration) =>
        run(
          (type, handler) => {
            if (type === 'online') online.push(handler);
          },
          {
            serviceWorker: {
              controller: {
                postMessage: (message: unknown): void => {
                  posted.push(message);
                },
              },
            },
          },
          registration,
        ),
    };
  }

  test('registers this package own sync tag when the platform has Background Sync', async () => {
    const sw = realm();
    const outcome = await sw.register({
      sync: {
        register: async (tag: string): Promise<void> => {
          sw.registered.push(tag);
        },
      },
    });

    expect(outcome).toBe('sync');
    expect(sw.registered).toEqual([SYNC_TAG]);
    expect(sw.online).toHaveLength(0);
  });

  test('falls back to an online listener that asks the controller to flush', async () => {
    const sw = realm();
    const outcome = await sw.register({});

    expect(outcome).toBe('fallback');
    expect(sw.registered).toEqual([]);
    expect(sw.online).toHaveLength(1);

    sw.online[0]?.();
    expect(sw.posted).toEqual([{ type: 'flush-outbox' }]);
  });

  test('a sync object without register() is not Background Sync', async () => {
    const sw = realm();
    expect(await sw.register({ sync: {} })).toBe('fallback');
    expect(sw.registered).toEqual([]);
  });
});
