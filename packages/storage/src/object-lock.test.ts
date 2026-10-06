// Object Lock on the two disks that EMULATE it — `localDriver` and `memoryDriver` — asked in one
// test per claim so neither can move alone. They keep one version per key, so a lock is kept by
// refusing the delete or the overwrite that would destroy the bytes until it lapses. The s3 half
// (headers on the wire, the provider's answer read back) is `driver-s3-lock.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`.
import { tmpdir } from 'node:os';
import { type FrozenClock, frozenClock, isUltimateError } from '@ultimat3/core';
import type { PutOptions, StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryDriver } from './driver-memory';
import { isLocked, ObjectLockedError } from './object-lock';

const KEY = 'org/o1/ledger.csv';
const DAY_MS = 86_400_000;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (thrown) {
    return thrown;
  }
  return 'resolved';
};
const codeOf = (thrown: unknown): string =>
  isUltimateError(thrown) ? thrown.code : `uncoded: ${String(thrown)}`;

let root = '';
let clock: FrozenClock;
let disks: readonly (readonly [string, StorageDriver])[];
const inADay = (): Date => new Date(clock.now().getTime() + DAY_MS);

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-object-lock-`);
  clock = frozenClock('2026-10-06T09:00:00.000Z');
  disks = [
    ['local', localDriver({ root, signingSecret: 'test-secret', clock })],
    ['memory', memoryDriver({ signingSecret: 'test-secret', clock })],
  ];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('retentionOf reads back what put() locked', () => {
  test('a retention and a hold round-trip, mode and instant exact', async () => {
    for (const [, disk] of disks) {
      const retainUntil = inADay();
      await disk.put(KEY, bytes('a'), { retention: { mode: 'COMPLIANCE', retainUntil } });
      expect(await disk.retentionOf?.(KEY)).toEqual({
        retention: { mode: 'COMPLIANCE', retainUntil },
        legalHold: false,
      });
      await disk.put('org/o1/held.csv', bytes('b'), { legalHold: true });
      expect(await disk.retentionOf?.('org/o1/held.csv')).toEqual({ legalHold: true });
    }
  });

  test('an unlocked object reports nothing locking it; an absent one is not found', async () => {
    for (const [, disk] of disks) {
      await disk.put(KEY, bytes('a'));
      expect(await disk.retentionOf?.(KEY)).toEqual({ legalHold: false });
      expect(
        codeOf(await caught(() => disk.retentionOf?.('org/o1/none') ?? Promise.resolve())),
      ).toBe('X_STORAGE_NOT_FOUND');
    }
  });

  test('the local lock is the sidecar’s, so a new driver over the same root still holds it', async () => {
    const retainUntil = inADay();
    await disks[0]?.[1].put(KEY, bytes('a'), { retention: { mode: 'GOVERNANCE', retainUntil } });
    const reopened = localDriver({ root, signingSecret: 'test-secret', clock });
    expect(await reopened.retentionOf?.(KEY)).toEqual({
      retention: { mode: 'GOVERNANCE', retainUntil },
      legalHold: false,
    });
    expect(codeOf(await caught(() => reopened.delete(KEY)))).toBe('X_STORAGE_OBJECT_LOCKED');
  });
});

describe('a locked object cannot be destroyed until the lock lapses', () => {
  test('delete is X_STORAGE_OBJECT_LOCKED, an ObjectLockedError, and the bytes stay', async () => {
    for (const [name, disk] of disks) {
      await disk.put(KEY, bytes('kept'), {
        retention: { mode: 'GOVERNANCE', retainUntil: inADay() },
      });
      const refused = await caught(() => disk.delete(KEY));
      expect(codeOf(refused), name).toBe('X_STORAGE_OBJECT_LOCKED');
      expect(refused, name).toBeInstanceOf(ObjectLockedError);
      const { cause, fix } = refused as ObjectLockedError;
      expect(cause).toContain(`"${KEY}"`);
      expect(cause).toContain(`GOVERNANCE retention until ${inADay().toISOString()}`);
      expect(cause).toContain('the stored bytes are unchanged');
      expect(fix).toStartWith(`disk('${name}').retentionOf("${KEY}")`);
      expect(new TextDecoder().decode((await disk.get(KEY)).bytes)).toBe('kept');
    }
  });

  test('an overwrite — put or copy onto the key — is X_STORAGE_OBJECT_LOCKED and the bytes stay', async () => {
    for (const [name, disk] of disks) {
      await disk.put(KEY, bytes('kept'), { legalHold: true });
      await disk.put('org/o1/other.csv', bytes('other'));
      const overwrite = await caught(() => disk.put(KEY, bytes('new')));
      const copy = await caught(() => disk.copy('org/o1/other.csv', KEY));
      expect([codeOf(overwrite), codeOf(copy)], name).toEqual([
        'X_STORAGE_OBJECT_LOCKED',
        'X_STORAGE_OBJECT_LOCKED',
      ]);
      expect((overwrite as ObjectLockedError).cause).toContain('refused to overwrite');
      expect((overwrite as ObjectLockedError).cause).toContain('a legal hold');
      expect((copy as ObjectLockedError).cause).toContain('refused to copy onto');
      expect(new TextDecoder().decode((await disk.get(KEY)).bytes)).toBe('kept');
    }
  });

  test('a legal hold on the local disk names the sidecar to edit', async () => {
    const [, local] = disks[0] ?? [];
    await local?.put(KEY, bytes('kept'), { legalHold: true });
    const refused = await caught(() => local?.delete(KEY) ?? Promise.resolve());
    expect((refused as { fix: string }).fix).toContain('"legalHold": false in');
    expect((refused as { fix: string }).fix).toContain('.meta/org/o1/ledger.csv.json');
  });

  test('once the retention lapses the object is ordinary again', async () => {
    for (const [name, disk] of disks) {
      await disk.put(KEY, bytes('kept'), {
        retention: { mode: 'COMPLIANCE', retainUntil: inADay() },
      });
      clock.advance(DAY_MS + 1);
      await disk.put(KEY, bytes('replaced'));
      expect(new TextDecoder().decode((await disk.get(KEY)).bytes), name).toBe('replaced');
      await disk.delete(KEY);
      expect(await disk.exists(KEY), name).toBe(false);
      clock.set('2026-10-06T09:00:00.000Z');
    }
  });

  test('a copy does not carry the source’s lock — on S3 it is per version, set by the request', async () => {
    for (const [, disk] of disks) {
      await disk.put(KEY, bytes('kept'), { legalHold: true });
      await disk.copy(KEY, 'org/o1/copy.csv');
      expect(await disk.retentionOf?.('org/o1/copy.csv')).toEqual({ legalHold: false });
      await disk.delete('org/o1/copy.csv');
    }
  });
});

describe('put() refuses a lock that cannot hold', () => {
  test.each<[string, PutOptions]>([
    ['a retainUntil in the past', { retention: { mode: 'COMPLIANCE', retainUntil: new Date(0) } }],
    [
      'an invalid retainUntil',
      { retention: { mode: 'COMPLIANCE', retainUntil: new Date(Number.NaN) } },
    ],
    [
      'a mode that is neither',
      {
        retention: { mode: 'FOREVER', retainUntil: new Date('2099-01-01') },
      } as unknown as PutOptions,
    ],
    ['a legalHold that is not a boolean', { legalHold: 'ON' } as unknown as PutOptions],
  ])('%s is X_INVARIANT and nothing is stored', async (_label, options) => {
    for (const [name, disk] of disks) {
      expect(codeOf(await caught(() => disk.put(KEY, bytes('x'), options))), name).toBe(
        'X_INVARIANT',
      );
      expect(await disk.exists(KEY), name).toBe(false);
    }
  });
});

describe('isLocked', () => {
  test('a hold always, a retention until its instant, nothing never', () => {
    const now = new Date('2026-10-06T09:00:00.000Z');
    const at = (iso: string) => ({ mode: 'GOVERNANCE' as const, retainUntil: new Date(iso) });
    expect(isLocked(undefined, now)).toBe(false);
    expect(isLocked({ legalHold: false }, now)).toBe(false);
    expect(isLocked({ legalHold: true }, now)).toBe(true);
    expect(isLocked({ legalHold: false, retention: at('2026-10-06T09:00:00.001Z') }, now)).toBe(
      true,
    );
    expect(isLocked({ legalHold: false, retention: at('2026-10-06T09:00:00.000Z') }, now)).toBe(
      false,
    );
  });
});
