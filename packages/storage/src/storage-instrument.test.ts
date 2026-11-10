// A disk resolved through `defineStorage` reports every call on the bus as `storage.<verb>` with a
// client span — success and failure alike — and a driver's call to its OWN methods is not counted
// twice. A driver held directly (never registered) is the caller's, and reports nothing.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ReadableSpan, StorageEvent } from '@ultimat3/core';
import {
  alwaysOnSampler,
  configureTelemetry,
  isUltimateError,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
} from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { defineStorage, resetStorage } from './storage';

function listen(): { events: { name: string; payload: StorageEvent }[]; spans: ReadableSpan[] } {
  const events: { name: string; payload: StorageEvent }[] = [];
  const spans: ReadableSpan[] = [];
  subscribe('storage', (event) => events.push({ name: event.name, payload: event.payload }));
  subscribe('span.end', (event) => spans.push(event.payload));
  return { events, spans };
}

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
  resetStorage();
});

describe('unit · storage · instrumentation', () => {
  test('put, stat, get, copy, list and delete each emit one event on the disk they ran on', async () => {
    configureTelemetry({ sampler: alwaysOnSampler });
    const uploads = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk('uploads');
    const seen = listen();
    await uploads.put('a/one.txt', bytes('hello'));
    await uploads.stat('a/one.txt');
    await uploads.get('a/one.txt');
    await uploads.copy('a/one.txt', 'a/two.txt');
    await uploads.list({ prefix: 'a/' });
    await uploads.delete('a/two.txt');
    expect(seen.events.map((event) => event.name)).toEqual([
      'storage.put',
      'storage.stat',
      'storage.get',
      'storage.copy',
      'storage.list',
      'storage.delete',
    ]);
    expect(seen.events[0]?.payload).toMatchObject({ disk: 'uploads', key: 'a/one.txt', bytes: 5 });
    expect(seen.events[2]?.payload.bytes).toBe(5);
    expect(seen.events[3]?.payload.key).toBe('a/two.txt');
    expect(seen.events[4]?.payload.key).toBe('a/');
    for (const { payload } of seen.events) expect(payload.error).toBeUndefined();
    const put = seen.spans.find((span) => span.name === 'storage.put');
    expect(put?.kind).toBe('client');
    expect(put?.attributes['ultimate.storage.disk']).toBe('uploads');
  });

  test('a failed call is still an event, carrying the error the caller receives', async () => {
    const uploads = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    const seen = listen();
    const thrown = await uploads.get('absent.txt').catch((error: unknown) => error);
    expect(isUltimateError(thrown)).toBe(true);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.payload.error).toBe(thrown);
  });

  test('a driver held directly, never registered, reports nothing', async () => {
    const raw = memoryStorageDriver();
    defineStorage({ disks: { uploads: raw } });
    const seen = listen();
    await raw.put('k.txt', bytes('x'));
    expect(seen.events).toEqual([]);
  });

  test('a disk is the same object on every resolution, and keeps its driver name', () => {
    const configured = defineStorage({ disks: { uploads: memoryStorageDriver() } });
    expect(configured.disk('uploads')).toBe(configured.disk());
    expect(configured.disk().name).toBe('memory');
  });

  test('a prototype member is never read as a verb: toString answers a string, and no event', () => {
    // The verb table is a plain object: `VERB_OF['toString']` answered Object.prototype's, so the
    // disk's toString came back wrapped as a storage call returning a Promise.
    const disk = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    const seen = listen();
    expect(typeof disk.toString()).toBe('string');
    expect(seen.events).toEqual([]);
  });
  test('a method assigned on the disk after first use runs, and is still reported', async () => {
    // The wrapper cached each method on first read and had no `set` trap: a test patching `put` to
    // simulate an outage changed the driver, and the cached original kept answering.
    const disk = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    await disk.put('warm.txt', bytes('x'));
    const seen = listen();
    const outage = new TypeError('disk full');
    disk.put = () => Promise.reject(outage);
    expect(await disk.put('k.txt', bytes('x')).catch((error: unknown) => error)).toBe(outage);
    expect(seen.events.map((event) => [event.name, event.payload.error])).toEqual([
      ['storage.put', outage],
    ]);
  });

  test.each([
    ['assigned', (disk: StorageDriver, put: StorageDriver['put']) => (disk.put = put)],
    [
      'defined',
      (disk: StorageDriver, put: StorageDriver['put']) =>
        Object.defineProperty(disk, 'put', { value: put, writable: true, configurable: true }),
    ],
  ])('a patch %s back restores the driver method, reported once', async (_, restore) => {
    const disk = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    const original = disk.put;
    disk.put = () => Promise.reject(new TypeError('disk full'));
    await disk.put('k.txt', bytes('x')).catch(() => undefined);
    restore(disk, original);
    const seen = listen();
    await disk.put('k.txt', bytes('xy'));
    expect(await disk.stat('k.txt')).toMatchObject({ size: 2 });
    expect(seen.events.map((event) => event.name)).toEqual(['storage.put', 'storage.stat']);
  });

  test('spyOn the declared driver takes effect on a warm disk, reported, and restores', async () => {
    // Bun's spyOn never writes through a Proxy (as of bun 1.4.4 it fires no trap): spy on the
    // driver you declared. The disk notices because its wrapper is keyed on the method it wraps.
    const driver = memoryStorageDriver();
    const disk = defineStorage({ disks: { uploads: driver } }).disk();
    await disk.put('warm.txt', bytes('x'));
    const outage = new TypeError('disk full');
    const spy = spyOn(driver, 'put').mockImplementation(() => Promise.reject(outage));
    const seen = listen();
    expect(await disk.put('k.txt', bytes('x')).catch((error: unknown) => error)).toBe(outage);
    expect(seen.events.map((event) => event.payload.error)).toEqual([outage]);
    spy.mockRestore();
    await disk.put('k.txt', bytes('xy'));
    expect(await disk.stat('k.txt')).toMatchObject({ size: 2 });
    expect(seen.events.map((event) => event.name)).toEqual([
      'storage.put',
      'storage.put',
      'storage.stat',
    ]);
  });
  test('a method set on an object inheriting from the disk shadows it there, never on the disk', async () => {
    // `Object.assign(Object.create(disk), { stat })` reaches the disk's `set` trap with the CHILD
    // as receiver. Written onto the driver, the child's `stat` calling `disk.stat` called itself.
    const disk = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    await disk.put('k.txt', bytes('xy'));
    const stat: StorageDriver['stat'] = async (key) => {
      const object = await disk.stat(key);
      return object === undefined ? undefined : { ...object, etag: 'shadowed' };
    };
    const child: StorageDriver = Object.assign(Object.create(disk), { stat });
    expect(await child.stat('k.txt')).toMatchObject({ size: 2, etag: 'shadowed' });
    expect(disk.stat).not.toBe(stat);
    expect((await disk.stat('k.txt'))?.etag).not.toBe('shadowed');
  });

  test('a saved original wrapped by a patch keeps calling the original', async () => {
    const disk = defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk();
    await disk.put('k.txt', bytes('xy'));
    const stat = disk.stat;
    let patched = 0;
    disk.stat = (key) => {
      patched += 1;
      return stat(key);
    };
    const seen = listen();
    expect(await disk.stat('k.txt')).toMatchObject({ size: 2 });
    expect(patched).toBe(1);
    expect(seen.events.map((event) => event.name)).toEqual(['storage.stat', 'storage.stat']);
  });
});
