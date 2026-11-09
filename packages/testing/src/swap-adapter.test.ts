// A swapped port is what its consumer reads for one test, and the value the test found again in the
// next; every row of core's `ADAPTER_PORTS` is either swappable or names what a test does instead.

import { beforeAll, describe, expect, test } from 'bun:test';
import { ADAPTER_PORT_NAMES, ambientClock, noWaitClock } from '@ultimat3/core';
import { eventBus, jobDriver, memoryEventBus, memoryJobDriver } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import { memoryMailDriver, tryMailDriver } from '@ultimat3/mail';
import { installMailDriver } from '@ultimat3/mail/adapter';
import { testMail } from './fixture-mail';
import { swapAdapter, UNSWAPPED } from './swap-adapter';
import { endTestScope } from './test-scope';
import { unitTest } from './test-types';

const foundQueue = jobDriver();
// The bus is not compared to a file-wide value: the preload hands every test a fresh one.
let swappedBus: unknown;
const foundMail = tryMailDriver();
const foundClock = ambientClock();

describe('swapAdapter', () => {
  test('the consumer reads the swapped adapter inside the test', async () => {
    const queue = await swapAdapter('jobs', memoryJobDriver());
    const bus = await swapAdapter('eventBus', memoryEventBus());
    const mail = await swapAdapter('mail', memoryMailDriver());
    const clock = await swapAdapter('clock', noWaitClock);
    expect(jobDriver()).toBe(queue);
    expect(eventBus()).toBe(bus);
    swappedBus = bus;
    expect(tryMailDriver()).toBe(mail);
    expect(ambientClock()).toBe(clock);
  });

  test('the next test reads what the file found', () => {
    expect(jobDriver()).toBe(foundQueue);
    expect(eventBus()).not.toBe(swappedBus);
    expect(tryMailDriver()).toBe(foundMail);
    expect(ambientClock()).toBe(foundClock);
  });

  test('two swaps of one port unwind to the first value', async () => {
    const first = await swapAdapter('jobs', memoryJobDriver());
    await swapAdapter('jobs', memoryJobDriver());
    expect(jobDriver()).not.toBe(first);
  });

  test('...and both are gone after it', () => {
    expect(jobDriver()).toBe(foundQueue);
  });

  test('a port with no slot is refused with what to do instead', async () => {
    await expect(swapAdapter('storage' as never, {} as never)).rejects.toThrow(
      expect.objectContaining({ code: 'X_TEST_ADAPTER_PORT_UNSWAPPABLE' }),
    );
    await expect(swapAdapter('nope' as never, {} as never)).rejects.toThrow(/no ADAPTER_PORTS row/);
  });

  test('every ADAPTER_PORTS row is swappable or says why not, and nothing else is listed', async () => {
    const unswapped = Object.keys(UNSWAPPED);
    for (const port of ADAPTER_PORT_NAMES) {
      if (unswapped.includes(port)) continue;
      // Swappable: the binding exists, so the refusal must not be the answer.
      await expect(swapAdapter(port as never, {} as never)).resolves.toBeDefined();
    }
    for (const port of unswapped) expect(ADAPTER_PORT_NAMES as readonly string[]).toContain(port);
  });
});

// The scope can end while the install is still loading its module (a timed-out test): the install
// that lands afterwards must be undone at once, never left to answer for every later test.
describe('a scope that ends mid-swap', () => {
  test('the late install is undone as it lands', async () => {
    const late = memoryJobDriver();
    const pending = swapAdapter('jobs', late);
    endTestScope();
    await pending;
    expect(jobDriver()).not.toBe(late);
  });
});

// A fixture and a swap on one port, undone in the "wrong" order: the fixture disposes at the end of
// the body, the swap after the test. Each removes ITS install and no other, so the next test reads
// what the file found — never the fixture's dead outbox, never the swap's driver.
describe('a fixture and a swap on one port', () => {
  // The file's own driver, under both: what every test of this block must find again.
  let fileMail: MailDriver | undefined;
  beforeAll(async () => {
    fileMail = await swapAdapter('mail', memoryMailDriver());
  });

  unitTest('the fixture installs, the test swaps over it', async ({ mail }) => {
    const mine = await swapAdapter('mail', memoryMailDriver());
    expect(tryMailDriver()).toBe(mine);
    expect(mail.outbox()).toEqual([]);
  });

  unitTest('a fixture disposed before the swap it sits under leaves no frame behind', async () => {
    const before = tryMailDriver();
    const swapped = memoryMailDriver();
    const release = installMailDriver(swapped);
    const mail = await testMail();
    release();
    mail[Symbol.dispose]();
    expect(tryMailDriver()).toBe(before);
  });

  unitTest('the next test reads the file’s driver again', () => {
    expect(tryMailDriver()).toBe(fileMail);
  });
});
