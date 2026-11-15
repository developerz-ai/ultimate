// Where a bundle lands, and how: two failures in the same millisecond (UUIDv7 ids share their first
// 12 hex digits) get two files, and the write is a temp file renamed over the target, so a kill
// mid-write leaves the old bundle or none — never truncated JSON.

import { describe, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { bundleFileOf } from './repro-archive';
import type { AtomicIo } from './repro-archive-write';
import { writeAtomically } from './repro-archive-write';
import { ReproUnknownError } from './repro-errors';

const requestWith = (requestId: string) => ({
  kind: 'request' as const,
  bundle: { id: 'b', requestId } as unknown as FailureBundle,
});

describe('bundleFileOf', () => {
  test('two UUIDv7 ids of one millisecond are two files', () => {
    const first = bundleFileOf(requestWith('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'));
    const second = bundleFileOf(requestWith('0190a1b2-c3d4-7111-9222-333344445555'));
    expect(first).not.toBe(second);
    expect(first).toBe('repro/bundle-0190a1b2c3d47e5f8a9b0c1d2e3f4a5b.json');
  });

  test('a long id keeps its head and its tail; an empty one is named', () => {
    const long = `${'a'.repeat(40)}${'b'.repeat(40)}`;
    expect(bundleFileOf(requestWith(long))).toBe(
      `repro/bundle-${'a'.repeat(24)}${'b'.repeat(24)}.json`,
    );
    expect(bundleFileOf(requestWith('--/--'))).toBe('repro/bundle-unnamed.json');
  });
});

/** A recording io: what was written where, and a rename that can be made to fail. */
function recording(failRename = false) {
  const calls: string[] = [];
  const io: AtomicIo = {
    write: async (path) => {
      calls.push(`write ${path}`);
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} -> ${to}`);
      // A coded refusal stands in for the filesystem's: what matters is that the rename throws.
      if (failRename) throw new ReproUnknownError({ id: 'rename' });
    },
    remove: async (path) => {
      calls.push(`remove ${path}`);
    },
  };
  return { io, calls };
}

describe('writeAtomically', () => {
  test('writes a temp file beside the target, then renames it over', async () => {
    const { io, calls } = recording();
    await writeAtomically('/app/repro/bundle-x.json', '{}', io);
    expect(calls).toHaveLength(2);
    const temp = calls[0]?.replace('write ', '') ?? '';
    expect(temp).toMatch(/^\/app\/repro\/bundle-x\.json\.[0-9a-f-]+\.tmp$/);
    expect(calls[1]).toBe(`rename ${temp} -> /app/repro/bundle-x.json`);
  });

  test('a failed rename removes the temp file and fails, the target untouched', async () => {
    const { io, calls } = recording(true);
    const code = await writeAtomically('/app/b.json', '{}', io).then(
      () => expect.unreachable('a refused rename was reported as written'),
      (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
    );
    expect(code).toBe('X_REPRO_UNKNOWN');
    expect(calls.at(-1)).toMatch(/^remove \/app\/b\.json\..+\.tmp$/);
    expect(calls.some((call) => call.startsWith('write /app/b.json '))).toBe(false);
  });
});
