// `@ultimat3/storage/adapter` resolves through the package's export map, and every value it carries is
// the `.` one by identity — an adapter author's import, never a copy of the package's own — except
// the driver-author-only names (`.` is the app API): the `uploadScanner` installer (`runtime.ts` is
// the one way to install) and the refusals only a driver raises.

import { describe, expect, test } from 'bun:test';

const VALUES: readonly string[] = [
  'assertPutOptions',
  'checksumMismatch',
  'deleteFailed',
  'etagOf',
  'getTooLarge',
  'isStorageError',
  'keyConflict',
  'objectNotFound',
  'putFailed',
  'readFailed',
  'resolveListLimit',
  'StorageError',
  'toBytes',
];

/** On `./adapter` only: a `.` export would be a second way to pick a scanner, or a driver's refusal. */
const ADAPTER_ONLY: readonly string[] = [
  'installUploadScanner',
  'listFailed',
  'pathUnsafe',
  'putTooLarge',
  'resetUploadScanner',
];

describe('unit · @ultimat3/storage/adapter', () => {
  test('is the subpath the export map names', () => {
    expect(import.meta.resolve('@ultimat3/storage/adapter')).toEndWith(
      // a file: URL — '/' on every OS
      '/packages/storage/src/adapter.ts',
    );
  });

  test('carries exactly its values, each the barrel export by identity', async () => {
    const adapter: Record<string, unknown> = await import('@ultimat3/storage/adapter');
    const barrel: Record<string, unknown> = await import('@ultimat3/storage');
    expect(Object.keys(adapter).sort()).toEqual([...VALUES, ...ADAPTER_ONLY].sort());
    for (const name of VALUES) expect([name, adapter[name] === barrel[name]]).toEqual([name, true]);
    for (const name of ADAPTER_ONLY) expect([name, name in barrel]).toEqual([name, false]);
  });
});
