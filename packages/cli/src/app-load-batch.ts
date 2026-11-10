// Importing many app modules at once, with the serial loop's guarantee: each module is evaluated,
// then handed to `onEvaluated`, before the next one starts — so a module reads every earlier one
// REGISTERED. A batch is an entry that imports one hook module per app module (`batchSources`);
// a module that can suspend (top-level await) is a batch of its own (`app-load-async.ts`).

// why: Bun ships no temp directory, no path API and no recursive delete of its own.
import { mkdir, rm } from 'node:fs/promises';
// why: as above — the batch lives in the platform temp root, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

/**
 * Modules per entry. A bound, not a tuning knob: the loader holds a batch's whole graph — every
 * source, every transpiled module — before it evaluates the first, so an unbounded entry over a
 * 12k-module app held all of it at once. Measured on a 5,000-module fixture (2026-11-09): 64 →
 * 1.04 s, 256 → 0.87 s, 1,000 → 0.84 s, serial → 1.36 s. The hooks cost their own module each:
 * re-measured 2026-11-10 (median of 5 cold boots), serial 2.19 s, hooked batches 1.39 s, and the
 * order-breaking hookless entry 0.90 s.
 */
export const BATCH_SIZE = 256;

/** One module's import: the namespace it evaluated to, or what it threw. */
export type Imported =
  | { readonly ok: true; readonly module: Record<string, unknown> }
  | { readonly ok: false; readonly error: unknown };

/**
 * Called once per module that evaluated, by its index in scan order, before the next module in
 * that order is evaluated. The scan registers here: what a later module reads at its top level —
 * `defineAppMcp({ include: 'exposed' })` reads the action registry — is what the serial scan left.
 */
export type OnEvaluated = (index: number, module: Record<string, unknown>) => void;

/** The global a hook module reports through: one well-known symbol, owned by `receiving`. */
const HOOK = 'ultimate.scan.evaluated';

/** The file one hook module is written to, beside its entry: named by the module's scan index. */
export const hookFile = (index: number): string => `m${String(index)}.ts`;

/**
 * One batch's sources: a hook per module — it imports the module and reports it — and an entry
 * that imports the hooks in order. ES evaluation walks the entry's imports depth-first, so hook N
 * runs after module N and before module N+1: a static graph the loader fetches concurrently, with
 * the serial loop's interleaving of evaluate and register. Never the modules themselves in one
 * entry: static imports evaluate every one before the entry's first statement runs.
 */
export function batchSources(
  specifiers: readonly string[],
  first: number,
): { readonly entry: string; readonly hooks: readonly (readonly [string, string])[] } {
  const hooks = specifiers.map((specifier, offset): readonly [string, string] => [
    hookFile(first + offset),
    `import * as m from ${JSON.stringify(specifier)};\n` +
      `globalThis[Symbol.for(${JSON.stringify(HOOK)})]?.(${String(first + offset)}, m);\n`,
  ]);
  const entry = hooks.map(([name]) => `import ${JSON.stringify(`./${name}`)};`).join('\n');
  return { entry: `${entry}\n`, hooks };
}

/**
 * Runs `load` with `receive` installed as the hooks' target, or answers `undefined` without
 * running it when another load holds the slot: two at once would hand one's modules to the other.
 * A receiver that throws is contained — a throw would fail the hook, and the batch with it.
 */
export async function receiving<T>(
  receive: OnEvaluated,
  load: () => Promise<T>,
): Promise<T | undefined> {
  const slot = Symbol.for(HOOK);
  if (Reflect.get(globalThis, slot) !== undefined) return undefined;
  const contained: OnEvaluated = (index, module) => {
    try {
      receive(index, module);
    } catch {
      // `registerModule` answers a finding, never a throw; anything else is not the batch's.
    }
  };
  Reflect.set(globalThis, slot, contained);
  try {
    return await load();
  } finally {
    Reflect.deleteProperty(globalThis, slot);
  }
}

/**
 * A directory no other batch has used — in this process or any copy of this module in it. Bun's
 * module cache is keyed by path and outlives a module instance: `bun test --parallel` evaluates
 * this file afresh per test file in one worker, and a per-instance counter named the same
 * directory twice, so the second load imported the first one's cached hooks and was handed the
 * first app's modules (2026-11-10, `app-load-batch.test.ts`).
 */
export const uniqueBatchName = (): string => `x-scan-${crypto.randomUUID()}`;

/** The serial import, for one module: what the batch falls back to. */
async function importOne(absolute: string): Promise<Imported> {
  try {
    return { ok: true, module: (await import(absolute)) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A batch's answers, filled by the hooks as they run and by the serial fallback after. */
type Slots = (Imported | undefined)[];

/** Imports `absolute` serially unless a hook already answered it, and reports a first evaluation. */
async function fillSerially(
  batch: readonly string[],
  first: number,
  slots: Slots,
  onEvaluated: OnEvaluated,
): Promise<void> {
  for (const [offset, absolute] of batch.entries()) {
    if (slots[offset] !== undefined) continue;
    const one = await importOne(absolute);
    slots[offset] = one;
    if (one.ok) onEvaluated(first + offset, one.module);
  }
}

/**
 * One batch. Any failure in it — a module that throws, one that cannot link — fails the entry:
 * every module before the failing one has evaluated and been reported, and the rest are imported
 * module by module — the failing one throws its own error again, every one after it evaluates in
 * its serial turn. A temp root that cannot be written (a read-only container) is the serial loop
 * too: slower, never wrong.
 */
async function importBatch(
  batch: readonly string[],
  first: number,
  onEvaluated: OnEvaluated,
): Promise<readonly Imported[]> {
  const slots: Slots = batch.map(() => undefined);
  if (batch.length > 1) {
    const dir = join(tmpdir(), uniqueBatchName());
    const { entry, hooks } = batchSources(
      batch.map((absolute) => Bun.pathToFileURL(absolute).href),
      first,
    );
    const receive: OnEvaluated = (index, module) => {
      slots[index - first] = { ok: true, module };
      onEvaluated(index, module);
    };
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all(hooks.map(([name, source]) => Bun.write(join(dir, name), source)));
      await Bun.write(join(dir, 'entry.ts'), entry);
      await receiving(receive, () => import(join(dir, 'entry.ts')));
    } catch {
      // Answered below, module by module, with each module's own error.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await fillSerially(batch, first, slots, onEvaluated);
  return slots as Imported[];
}

/**
 * `absolutes` cut into entry-sized batches, in order. A module in `alone` — one whose evaluation can
 * suspend — ends the batch before it and is a batch by itself: an entry module waits for it before
 * anything after it starts. The scan and the prebuilt registry both cut here, so both keep order.
 */
export function planBatches(
  absolutes: readonly string[],
  alone: ReadonlySet<string> = new Set(),
): readonly (readonly string[])[] {
  const batches: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
  };
  for (const absolute of absolutes) {
    if (alone.has(absolute)) {
      flush();
      batches.push([absolute]);
      continue;
    }
    current.push(absolute);
    if (current.length === BATCH_SIZE) flush();
  }
  flush();
  return batches;
}

/**
 * Every module of `absolutes`, imported in `planBatches`' batches and answered in the same order;
 * `onEvaluated` hears each module that evaluated, in that order, before the next one evaluates.
 */
export async function importInOrder(
  absolutes: readonly string[],
  alone: ReadonlySet<string> = new Set(),
  onEvaluated: OnEvaluated = () => undefined,
): Promise<readonly Imported[]> {
  const imported: Imported[] = [];
  for (const batch of planBatches(absolutes, alone)) {
    imported.push(...(await importBatch(batch, imported.length, onEvaluated)));
  }
  return imported;
}
