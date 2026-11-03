// Where an import's bytes come from, read one window at a time.
//
// A SEAM and not a `@ultimat3/storage` import, for the reason `ExportSink` is one: jobs is tier 3
// and holds no storage dependency. A `StorageDriver` satisfies it by having the two methods it
// already has — `stat(key)` and `get(key, { range: [first, last] })` — so `disk('imports')` IS an
// `ImportSource`; `scripts/export-sink.test.ts` compiles that assignment.

/** What `stat` must know: the object's whole length, so the pass knows which window is the last. */
export interface ImportObject {
  readonly size: number;
}

export interface ImportSource {
  /** `undefined` when no object is at the key — `StorageDriver.stat`'s own answer. */
  stat(key: string): Promise<ImportObject | undefined>;
  /**
   * The bytes `[first, last]`, BOTH inclusive and clamped to the object, as HTTP's `Range:` and
   * `StorageDriver.get`'s `range` read. Never called without a range: the whole object is exactly
   * what this seam exists not to hold.
   */
  get(
    key: string,
    options: { readonly range: readonly [first: number, last: number] },
  ): Promise<{ readonly bytes: Uint8Array }>;
}

export interface MemoryImportSource extends ImportSource {
  /** Every range asked for, in order — what a test reads to prove the pass never read whole. */
  reads(): readonly (readonly [number, number])[];
}

/** The dev and test source: one key, one buffer, the same clamp a real disk applies. */
export function memoryImportSource(
  objects: Readonly<Record<string, Uint8Array>>,
): MemoryImportSource {
  const reads: (readonly [number, number])[] = [];
  return {
    stat: (key) => {
      const object = objects[key];
      return Promise.resolve(object === undefined ? undefined : { size: object.byteLength });
    },
    get: (key, { range }) => {
      reads.push([range[0], range[1]]);
      const object = objects[key] ?? new Uint8Array();
      return Promise.resolve({ bytes: object.slice(range[0], range[1] + 1) });
    },
    reads: () => [...reads],
  };
}
