// `@ultimat3/storage/adapter` resolves through the package's export map, and every value it carries is
// the `.` one by identity — an adapter author's import, never a copy of the package's own — except
// the `uploadScanner` installer, which is here and NOT on `.`: `runtime.ts` is the one way to install.

import { describe, expect, test } from 'bun:test';

const VALUES: readonly string[] = [
  'assertPutOptions',
  'checksumMismatch',
  'deleteFailed',
  'etagOf',
  'getTooLarge',
  'isStorageError',
  'keyConflict',
  'listFailed',
  'objectNotFound',
  'pathUnsafe',
  'putFailed',
  'putTooLarge',
  'readFailed',
  'resolveListLimit',
  'StorageError',
  'toBytes',
];

/** On `./adapter` only: a `.` export would be a second way to pick a scanner. */
const INSTALLERS: readonly string[] = ['installUploadScanner', 'resetUploadScanner'];

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
    expect(Object.keys(adapter).sort()).toEqual([...VALUES, ...INSTALLERS].sort());
    for (const name of VALUES) expect([name, adapter[name] === barrel[name]]).toEqual([name, true]);
    for (const name of INSTALLERS) expect([name, name in barrel]).toEqual([name, false]);
  });
});
