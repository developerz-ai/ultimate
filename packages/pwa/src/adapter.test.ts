// `@ultimat3/pwa/adapter` resolves through the package's export map, and every value it carries is
// the `.` one by identity — an adapter author's import, never a copy of the package's own.

import { describe, expect, test } from 'bun:test';

const VALUES: readonly string[] = [];

describe('unit · @ultimat3/pwa/adapter', () => {
  test('is the subpath the export map names', () => {
    expect(Bun.fileURLToPath(import.meta.resolve('@ultimat3/pwa/adapter'))).toEndWith(
      '/packages/pwa/src/adapter.ts',
    );
  });

  test('carries exactly its values, each the barrel export by identity', async () => {
    const adapter: Record<string, unknown> = await import('@ultimat3/pwa/adapter');
    const barrel: Record<string, unknown> = await import('@ultimat3/pwa');
    expect(Object.keys(adapter).sort()).toEqual([...VALUES].sort());
    for (const name of VALUES) expect([name, adapter[name] === barrel[name]]).toEqual([name, true]);
  });
});
