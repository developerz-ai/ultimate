// What the app DECLARED, as against what `x_backfills` recorded. The ledger answers "which passes
// have run"; until this file nothing answered "which passes exist", so a cleanup that was merged
// and never enqueued had no ledger row and was invisible on every surface — the incident where
// four rewrites shipped and simply never happened.
//
// The stamp is `task.ts`'s `origin` WeakMap and deliberately not a second mechanism, and not an
// app-side `registerBackfill()` call either: `backfill()` returns a plain `JobHandle`, so the
// declaration's own fields have nowhere on the handle to live, and asking an app to register what
// it already declared is the coupling axiom 8's extension model exists to refuse.

import type { Ctx, Environment } from '@ultimat3/core';
// TYPE-only, and that is what makes it safe: `backfill.ts` imports this module at runtime, and a
// second declaration of its input here would be a second name for one shape (axiom 1).
import type { BackfillInput } from './backfill';
import type { AnyJobHandle, JobHandle } from './job';
import { isJobHandle, registeredJobs } from './job';

/**
 * How many rows still match — the same predicate `source` selects on, counted rather than read.
 * Handed a `Ctx` for the reason `source` is: a tenanted sweep counts within one org or it counts
 * every tenant at once.
 */
export type BackfillCount = (args: { readonly ctx: Ctx }) => Promise<number> | number;

/** Everything `backfill()` knows that a `JobHandle` has no field for. */
export interface BackfillOrigin {
  readonly checksum: string;
  /** A migration id, checked against `x_migrations` by whoever can read it. See `backfill.ts`. */
  readonly requires: string | undefined;
  /** Absent means every environment — never an implied "production only". See `backfill.ts`. */
  readonly environments: readonly Environment[] | undefined;
  readonly count: BackfillCount | undefined;
}

/**
 * One declaration as every surface reports it: plain JSON, absent as `null`, the shape
 * `BackfillProgress` already holds for a ledger row. `counts` rather than the function itself —
 * a declaration crosses `--json`, and "can this pass say how many rows are left" is the only
 * thing a reader can act on.
 */
export interface BackfillDeclaration {
  readonly kind: 'backfill';
  readonly name: string;
  readonly checksum: string;
  readonly requires: string | null;
  readonly environments: readonly Environment[] | null;
  readonly counts: boolean;
}

const origin = new WeakMap<object, BackfillOrigin>();

/**
 * Called by `backfill()` and by nothing else — not exported from `src/index.ts`, for the reason
 * `registerJob` is not: a second way to make a handle claim it is a backfill would let a plain
 * `job()` inherit the pending diff, the gate and the deploy trigger it was never declared for.
 */
export function stampBackfill(handle: JobHandle<BackfillInput>, source: BackfillOrigin): void {
  origin.set(handle, source);
}

/**
 * Structural, exactly as `isJobHandle`/`isTaskHandle` are: a job handle plus proof `backfill()`
 * built it. A look-alike carrying the right fields is still a job.
 */
export function isBackfill(value: unknown): value is JobHandle<BackfillInput> {
  return isJobHandle(value) && origin.has(value);
}

/** What `backfill()` stamped, or nothing. The `count` function lives here and never in JSON. */
export function backfillOrigin(handle: AnyJobHandle): BackfillOrigin | undefined {
  return origin.get(handle);
}

/** Reads `handle.name` live, never a captured copy: registration rebinds that property in place. */
export function declarationOf(handle: AnyJobHandle): BackfillDeclaration | undefined {
  const source = origin.get(handle);
  if (source === undefined) return undefined;
  return {
    kind: 'backfill',
    name: handle.name,
    checksum: source.checksum,
    requires: source.requires ?? null,
    environments: source.environments ?? null,
    counts: source.count !== undefined,
  };
}

/**
 * Every backfill this process's modules declared, by name. Derived from `registeredJobs()` rather
 * than from a second registry of its own: a backfill IS a job, and two registries that disagreed
 * about one name would be two answers to "does this pass exist".
 */
export function registeredBackfills(): readonly BackfillDeclaration[] {
  const declarations: BackfillDeclaration[] = [];
  for (const handle of registeredJobs()) {
    const declaration = declarationOf(handle);
    if (declaration !== undefined) declarations.push(declaration);
  }
  return declarations;
}

/** The handle behind a declared name, for the surface that has to enqueue it. */
export function getBackfill(name: string): JobHandle<BackfillInput> | undefined {
  for (const handle of registeredJobs()) {
    if (handle.name === name && isBackfill(handle)) return handle;
  }
  return undefined;
}
