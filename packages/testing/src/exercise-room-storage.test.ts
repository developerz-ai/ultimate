// A storage write the observed call made is one of its effects, counted per disk and verb — so an
// upload action that writes only an object reads as a reach with an effect, never an empty one.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { mergeObserved } from './exercise-observed';
import type { ExerciseRoom, Observed } from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { testName } from './test-types';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const uploads = () => defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk('uploads');

const observed = async (room: ExerciseRoom, fn: () => Promise<unknown>): Promise<Observed> => {
  const seen = await room.observe('upload', fn);
  if ('error' in seen) return expect.unreachable('the observed call answered');
  return seen.observed;
};

afterEach(() => resetStorage());

describe(testName('unit', 'exercise room storage effects'), () => {
  test('each put, copy and delete the call made is a storage effect of its disk, counted', async () => {
    const disk = uploads();
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      await disk.put('org/a/one.txt', bytes('one'));
      await disk.put('org/a/two.txt', bytes('two'));
      await disk.copy('org/a/one.txt', 'org/a/three.txt');
      await disk.delete('org/a/two.txt');
    });
    expect(seen.effects).toEqual([
      { kind: 'storage', disk: 'uploads', op: 'put', count: 2 },
      { kind: 'storage', disk: 'uploads', op: 'copy', count: 1 },
      { kind: 'storage', disk: 'uploads', op: 'delete', count: 1 },
    ]);
  });

  test('a multipart session the call opened, filled, assembled or dropped is a storage effect', async () => {
    const disk = uploads();
    const multipart = disk.multipart;
    if (multipart === undefined) return expect.unreachable('the memory disk takes multipart');
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      const kept = await multipart.create('org/a/big.csv', { contentType: 'text/csv' });
      const part = await multipart.receivePart?.('org/a/big.csv', kept, 1, bytes('hello'));
      await multipart.complete('org/a/big.csv', kept, part === undefined ? [] : [part]);
      const dropped = await multipart.create('org/a/gone.csv', { contentType: 'text/csv' });
      await multipart.abort('org/a/gone.csv', dropped);
    });
    expect(seen.effects).toEqual([
      { kind: 'storage', disk: 'uploads', op: 'multipart.create', count: 2 },
      { kind: 'storage', disk: 'uploads', op: 'multipart.part', count: 1 },
      { kind: 'storage', disk: 'uploads', op: 'multipart.complete', count: 1 },
      { kind: 'storage', disk: 'uploads', op: 'multipart.abort', count: 1 },
    ]);
  });

  test('a read is no effect, and a write outside the call is not the call’s', async () => {
    const disk = uploads();
    await using room = await openExerciseRoom();
    await disk.put('org/a/one.txt', bytes('one'));
    // Started outside the call and finished while it awaits: a neighbour's write in its window.
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const neighbour = (async () => {
      await gate;
      await disk.put('org/b/two.txt', bytes('two'));
    })();
    const seen = await observed(room, async () => {
      open();
      await neighbour;
      await disk.get('org/a/one.txt');
      await disk.stat('org/a/one.txt');
      await disk.list({ prefix: 'org/a/' });
    });
    expect(seen.effects).toEqual([]);
  });

  test('a write the driver refused wrote nothing, and is no effect', async () => {
    const disk = uploads();
    await using room = await openExerciseRoom();
    const seen = await room.observe('upload', () => disk.put('../escape.txt', bytes('x')));
    expect('error' in seen).toBe(true);
    expect(seen.observed.effects).toEqual([]);
  });

  test('two calls’ writes merge into one count, as two mails do', async () => {
    const disk = uploads();
    await using room = await openExerciseRoom();
    const put = async (): Promise<void> => {
      await disk.put('org/a/one.txt', bytes('one'));
    };
    const merged = mergeObserved([await observed(room, put), await observed(room, put)]);
    expect(merged.effects).toEqual([{ kind: 'storage', disk: 'uploads', op: 'put', count: 2 }]);
  });
});
