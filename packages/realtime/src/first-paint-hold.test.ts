// The hold a realtime island's bootstrap awaits before its module graph lets `mount` run (#506):
// released by the restore it waits on, and by its cap when that restore never comes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FIRST_PAINT_HOLD_MS, holdFirstPaint } from './first-paint-hold';
import { resetPage } from './hooks-fixture';
import { OUTBOX_KEY, type OutboxHandle, type OutboxHost } from './outbox-slot';
import { BOOT_KEY, type BootHost } from './page-store';

const boot = globalThis as BootHost;
const outboxHost = globalThis as OutboxHost;

const realSetTimeout = globalThis.setTimeout;
/** Fires the hold's cap now, instead of after `FIRST_PAINT_HOLD_MS` of wall time. */
let fireCap = (): void => undefined;

beforeEach(() => {
  fireCap = () => expect.unreachable('the hold armed no cap');
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === FIRST_PAINT_HOLD_MS) fireCap = fn;
    return realSetTimeout(() => undefined, 0);
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  Reflect.deleteProperty(boot, BOOT_KEY);
  Reflect.deleteProperty(outboxHost, OUTBOX_KEY);
  resetPage();
});

/** A promise the test settles by hand, and whether anything awaiting it has seen it settle. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve = (): void => undefined;
  let reject = (): void => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = () => yes();
    reject = () => no(new TypeError('the disk refused'));
  });
  return { promise, resolve, reject };
}

const seat = (key: typeof BOOT_KEY, value: Promise<void>): void => {
  Object.defineProperty(boot, key, { value, configurable: true });
};

const outbox = (ready: Promise<void>): void => {
  const handle: OutboxHandle = {
    enqueue: async () => undefined,
    replay: async () => undefined,
    pending: () => [],
    size: 0,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    ready,
  };
  Object.defineProperty(outboxHost, OUTBOX_KEY, { value: handle, configurable: true });
};

/** Whether `promise` has settled after the microtasks already queued have run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return settled;
}

describe('holdFirstPaint', () => {
  test('a page with no boot is not held', async () => {
    expect(await holdFirstPaint()).toBe('settled');
  });

  test('waits for the boot AND the outbox it opened, the queue overlays are rebuilt from', async () => {
    const booted = deferred();
    const ready = deferred();
    seat(BOOT_KEY, booted.promise);
    const held = holdFirstPaint();
    expect(await settledYet(held)).toBe(false);
    // The boot opens the outbox as its last step, so it is seated once the boot resolves.
    outbox(ready.promise);
    booted.resolve();
    expect(await settledYet(held)).toBe(false);
    ready.resolve();
    expect(await held).toBe('settled');
  });

  test('a boot that never resolves is capped, so the island still mounts', async () => {
    seat(BOOT_KEY, new Promise<void>(() => undefined));
    const held = holdFirstPaint();
    expect(await settledYet(held)).toBe(false);
    fireCap();
    expect(await held).toBe('capped');
  });

  test('an outbox that never opens is capped too', async () => {
    seat(BOOT_KEY, Promise.resolve());
    outbox(new Promise<void>(() => undefined));
    const held = holdFirstPaint();
    expect(await settledYet(held)).toBe(false);
    fireCap();
    expect(await held).toBe('capped');
  });

  test('a refused restore releases the hold — the island mounts, never rejects', async () => {
    const booted = deferred();
    seat(BOOT_KEY, booted.promise);
    const held = holdFirstPaint();
    booted.reject();
    expect(await held).toBe('settled');
  });

  test('the default cap is a bounded second, not a hang', () => {
    expect(FIRST_PAINT_HOLD_MS).toBeGreaterThan(0);
    expect(FIRST_PAINT_HOLD_MS).toBeLessThanOrEqual(1_000);
  });
});
