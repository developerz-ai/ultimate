// Compile the assignment three comments assert and nothing checked: a `StorageDriver` IS an
// `ExportSink`.
//
// `packages/jobs/src/export-sink.ts`, `export.ts` and `packages/jobs/README.md` all state that
// `sink: disk('exports')` works, and `ExportSink.put` returned `Promise<void>` while
// `StorageDriver.put` returns `Promise<StorageObject>` — so the assignment did not typecheck and
// the feature's own documented call site was the one thing that could not compile.
//
// It lives in `scripts/` and not in `@ultimat3/jobs` for the reason the seam exists at all: jobs
// is tier 3 and holds no `@ultimat3/storage` dependency, so the package that declares the seam is
// the one package that can never test it. Same shape as `scripts/browser-barrel.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { ExportSink } from '@ultimat3/jobs';
import type { StorageDriver } from '@ultimat3/storage';

describe('the ExportSink seam', () => {
  test('a StorageDriver is assignable to an ExportSink', () => {
    // The assertion IS the compile: if `put`'s shapes drift, this file stops typechecking and the
    // gate's `typecheck` step fails before this test ever runs.
    const accepts = (sink: ExportSink): ExportSink => sink;
    const driver = undefined as unknown as StorageDriver;
    const sink: ExportSink = driver;
    expect(accepts(sink)).toBe(driver);
  });

  test("the sink discards the driver's answer rather than forbidding one", () => {
    // `Promise<void>` is what broke it. A sink that returns a value must still satisfy the seam,
    // because every real driver does — the pass ignores what comes back.
    const returning: ExportSink = { put: async () => ({ key: 'k', size: 1 }) };
    const returningNothing: ExportSink = { put: async () => undefined };
    expect(typeof returning.put).toBe('function');
    expect(typeof returningNothing.put).toBe('function');
  });

  test('a Uint8Array is the body both sides accept', async () => {
    const written: { key: string; bytes: number }[] = [];
    const sink: ExportSink = {
      put: async (key, body) => {
        written.push({ key, bytes: body.byteLength });
        return { key };
      },
    };
    await sink.put('exports/o/part-00000.csv', new Uint8Array([1, 2, 3]));
    expect(written).toEqual([{ key: 'exports/o/part-00000.csv', bytes: 3 }]);
  });
});
