// The page boot: it installs the page runtime ONCE per page, whoever boots or installs first, and
// `booted` answers only once the principal's records are back and the outbox is open. And its wipe
// across a principal change: WHOSE disk is kept is decided at the wipe, never at the boot's start.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { CLIENT_PERSIST_META, CLIENT_SCOPE_META, pageClient } from '@ultimat3/core/page';
import { bootPage } from './boot';
import { resetPage } from './hooks-fixture';
import { type LocalStore, MemoryLocalStore, memoryLocalStore } from './local-store-idb';
import { peekOutbox } from './outbox-slot';
import { installPageRuntime } from './page-runtime';
import { installedPage, pageRealtime } from './page-store';

const DISK = Symbol.for('ultimate.local-store');
const host = globalThis as { document?: unknown };

afterEach(() => {
  Reflect.deleteProperty(globalThis, DISK);
  delete host.document;
  resetPage();
  rescope(null);
});

/** The page's one disk, ready now — so a case reads what the boot did to it, not a real IDB. */
function seatDisk(disk: LocalStore): void {
  Object.defineProperty(globalThis, DISK, { value: Promise.resolve(disk), configurable: true });
}

/** The page's one disk, still opening: the boot parks on it until the case calls `open`. */
function parkDisk(): { open(disk: LocalStore): void } {
  let open: (disk: LocalStore) => void = () => undefined;
  const opening = new Promise<LocalStore>((resolve) => {
    open = resolve;
  });
  Object.defineProperty(globalThis, DISK, { value: opening, configurable: true });
  return { open: (disk) => open(disk) };
}

/** A real memory disk that also counts the boot's once-per-page step: the wipe. Counts, nothing more. */
class CountingDisk extends MemoryLocalStore {
  wipes = 0;
  override async wipeOthers(keep: string): Promise<void> {
    this.wipes += 1;
    await super.wipeOthers(keep);
  }
}

/** A real memory disk whose record read waits on the case: the restore's one slow step, held. */
class GatedDisk extends MemoryLocalStore {
  #release: () => void = () => undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  override async rows(scope: string): ReturnType<MemoryLocalStore['rows']> {
    await this.#gate;
    return super.rows(scope);
  }
}

/** Every pending promise callback run: the memory disk answers in microtasks, never on a timer. */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the boot installs the page runtime exactly once', () => {
  test('synchronously, before its first await: an island released by its load finds the store', () => {
    seatDisk(memoryLocalStore());
    void bootPage({ principal: 'u1' });
    // No await between the call and this line: `awaitPageRuntime` resolves on the script's `load`.
    const page = installedPage('useRecord');
    expect(pageClient().store).toBe(page.store);
  });

  test('boots again and again: one promise, one store, one set of services, one wipe', async () => {
    const disk = new CountingDisk();
    seatDisk(disk);
    const first = bootPage({ principal: 'u1' });
    const { store, services } = installedPage('first');
    const again = [bootPage({ principal: 'u1' }), bootPage(), bootPage({ principal: 'u2' })];
    for (const boot of again) expect(boot).toBe(first);
    await first;
    await drain();
    expect(installedPage('again').store).toBe(store);
    expect(installedPage('again').services).toBe(services);
    expect(disk.wipes).toBe(1);
  });

  test("the runtime chunk installed first: the boot adopts that page's store, never replaces it", async () => {
    seatDisk(memoryLocalStore());
    // An island on a page whose boot came late installed the runtime from its chunk.
    const chunk = installPageRuntime();
    const { store, services } = chunk;
    store.adopt('posts', { p1: { id: 'p1', likeCount: 2 } });
    await bootPage({ principal: 'u1' });
    expect(installedPage('after').store).toBe(store);
    expect(installedPage('after').services).toBe(services);
    expect(pageClient().store).toBe(store);
    expect(store.peek('posts', 'p1')).toEqual({ id: 'p1', likeCount: 2 });
  });

  test("an island that asked first: the boot claims its placeholder, and it is the page's one boot", async () => {
    const disk = new CountingDisk();
    const parked = parkDisk();
    // Still parsing, with the scope tag the CLI renders beside the boot: a boot is coming.
    host.document = {
      readyState: 'interactive',
      querySelector: (selector: string) => (selector.includes(CLIENT_SCOPE_META) ? {} : null),
    };
    const waiting = pageRealtime().booted;
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    expect(bootPage({ principal: 'u1' })).toBe(waiting);
    expect(bootPage({ principal: 'u1' })).toBe(waiting);
    expect(pageRealtime().booted).toBe(waiting);
    await drain();
    expect(settled).toBe(false); // the disk is still opening: nothing is restored yet

    parked.open(disk);
    await waiting;
    await drain();
    expect(disk.wipes).toBe(1);
    expect(peekOutbox()).toBeDefined();
  });
});

describe('`booted` resolves only once the page is restored', () => {
  test('after the persisted records are in the store and the outbox is open — never before', async () => {
    const disk = new GatedDisk();
    await disk.write('p:u1', [{ type: 'posts', key: 'p1', row: { id: 'p1', likeCount: 7 } }], []);
    await disk.writeQueue('p:u1', queued('u1-like'));
    const parked = parkDisk();
    rescope('u1'); // the persister reads the page's own principal, as the boot's wipe does
    // The document marks `posts` persisted. Read once, synchronously, as the boot starts; gone
    // again before the outbox opens, so the outbox is the memory one and arms no listeners.
    host.document = {
      readyState: 'complete',
      querySelector: (selector: string) =>
        selector.includes(CLIENT_PERSIST_META) ? { content: 'posts' } : null,
    };
    const booted = bootPage();
    delete host.document;
    const store = installedPage('restore').store;

    // What an island sees at the moment `booted` settles: taken in the settle's own callback.
    let atBoot: { row: unknown; outbox: boolean } | undefined;
    void booted.then(() => {
      atBoot = { row: store.peek('posts', 'p1'), outbox: peekOutbox() !== undefined };
    });
    await drain();
    expect(atBoot).toBeUndefined();
    expect(store.peek('posts', 'p1')).toBeUndefined();

    // Opened, and wiped — but the records are still being read: not booted yet either.
    parked.open(disk);
    await drain();
    expect(atBoot).toBeUndefined();

    disk.release();
    await booted;
    expect(atBoot).toEqual({ row: { id: 'p1', likeCount: 7 }, outbox: true });
    // The outbox it opened is the previous load's queue: what rebuilds the overlays.
    const outbox = peekOutbox();
    await outbox?.ready;
    expect(outbox?.pending().map((entry) => entry.key)).toEqual(['u1-like']);
  });
});

const queued = (key: string) => ({
  puts: [
    {
      key,
      seq: 1,
      name: 'likePost',
      input: {},
      enqueuedAt: 0,
      attempts: 0,
      status: 'pending' as const,
      error: null,
    },
  ],
  deletes: [],
  nextSeq: 2,
});

describe('a principal change while the boot is opening the disk', () => {
  test("keeps the NEW principal's queue and wipes the one that left", async () => {
    const disk = memoryLocalStore();
    await disk.writeQueue('p:u1', queued('u1-like'));
    await disk.writeQueue('p:u2', queued('u2-like'));
    // The page's one store, still opening: the boot parks on it before it wipes anything.
    let opened: (store: LocalStore) => void = () => undefined;
    Object.defineProperty(globalThis, DISK, {
      value: new Promise<LocalStore>((resolve) => {
        opened = resolve;
      }),
      configurable: true,
    });
    rescope('u1');

    const booted = bootPage();
    rescope('u2');
    opened(disk);
    await booted;

    expect((await disk.queue('p:u2'))?.mutations.map((m) => m.key)).toEqual(['u2-like']);
    expect(await disk.queue('p:u1')).toBeUndefined();
  });

  test('a boot handed its scope explicitly still keeps exactly that one', async () => {
    const disk = memoryLocalStore();
    await disk.writeQueue('p:u1', queued('u1-like'));
    await disk.writeQueue('p:u2', queued('u2-like'));
    Object.defineProperty(globalThis, DISK, { value: Promise.resolve(disk), configurable: true });
    rescope('u1');
    await bootPage({ principal: 'u1' });
    expect((await disk.queue('p:u1'))?.mutations.map((m) => m.key)).toEqual(['u1-like']);
    expect(await disk.queue('p:u2')).toBeUndefined();
  });
});
