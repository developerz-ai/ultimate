// The `task` primitive: a cron declaration and its registry. A task NEVER does work — it
// enqueues jobs, so retries, idempotency and observability all come from the job machinery
// instead of being re-invented per cron. `scheduler.ts` is what fires one.
//
// `tz` is required by the type. A cron without a timezone is a bug waiting for March: `0 3 *
// * *` in a DST-observing zone runs twice or zero times on the switch day, and "the nightly
// digest went out at 2am and again at 3am" is not a mystery anyone should have to debug.
//
// **The framework's DST answer, `As of 2026-08`: ONE occurrence per calendar day, at the first
// valid instant.** Pinned against a real zone in `scheduler-dst.test.ts`, both transitions:
//
//   FALL BACK — the repeated wall-clock hour yields ONE occurrence, the first (CEST) instant. It
//   has to: `scheduler.ts`'s `dispatch` keys the idempotency key on `occurrenceMs`, and the two
//   instants of a repeated 02:00 genuinely differ, so two occurrences would be two keys and the
//   nightly digest would go out twice — the exact failure a required `tz` exists to prevent.
//   Nothing downstream could catch it.
//   SPRING FORWARD — the missing hour SHIFTS forward (02:00 fires at 03:00), never skips. A
//   skipped day is a billing run that silently never happened, which is worse than one an hour
//   late, and `catchUp` cannot recover an occurrence that was never an occurrence.

import { assert } from '@ultimat3/core';
import { isValidTimeZone } from '@ultimat3/time';
import { nowMs } from './clock';
import type { EnqueueResult } from './driver';
import { JobNameTakenError } from './errors';
import type { AnyJobHandle } from './job';
import type { EnqueueOptions } from './outbox';

/** `[[sendDigest, {}]]` — a job handle plus its input. */
export type TaskEnqueueEntry = readonly [AnyJobHandle, unknown];

/**
 * What to do when the scheduler was down across one or more occurrences.
 * `skip` (default) collapses them into ONE dispatch for the LATEST missed occurrence — the
 * older ones are dropped, never replayed; `run-once` fires a single catch-up, the EARLIEST
 * missed one; `run-all` fires one per missed occurrence, bounded by `maxCatchUp`.
 */
export type CatchUpPolicy = 'skip' | 'run-once' | 'run-all';

export interface TaskDefinition {
  /** Omit it: `defineApi({ tasks })` assigns the export name. Set it only to pin the name the
   * scheduler's `lastFiredAt` and occurrence lock are already keyed by. */
  readonly name?: string;
  readonly cron: string;
  /** REQUIRED IANA zone, e.g. `'UTC'`, `'America/New_York'`. */
  readonly tz: string;
  /**
   * Builds the entries for ONE occurrence, given that occurrence's instant in epoch ms.
   *
   * The argument exists because catch-up does: a tick dispatched late, or replayed for a
   * missed occurrence, has a wall clock that no longer matches the occurrence being fired.
   * A payload derived from `Date.now()` there is silently for the wrong day — and the
   * scheduler's own key is occurrence-scoped, so nothing downstream catches it.
   */
  enqueue: (occurrenceMs: number) => readonly TaskEnqueueEntry[];
  readonly catchUp?: CatchUpPolicy;
  /** Whole occurrences per round, one or more. Zero fires nothing at all, and `task()` refuses it. */
  readonly maxCatchUp?: number;
}

/** One entry's outcome, from a scheduled dispatch or a manual `task.enqueue()` alike. */
export interface TaskJobResult {
  readonly job: string;
  readonly result: EnqueueResult;
}

/** JSON-safe view of a task for the manifest, `/_x` and the MCP dev server. */
export interface TaskDescriptor {
  readonly kind: 'task';
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly catchUp: CatchUpPolicy;
  readonly maxCatchUp: number;
  readonly jobs: readonly string[];
}

export interface TaskHandle {
  readonly kind: 'task';
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly catchUp: CatchUpPolicy;
  readonly maxCatchUp: number;
  /**
   * Entries for `occurrenceMs`. Defaults to now, which is the honest answer for the two
   * callers that have no occurrence: a manual `task.enqueue()` and `describe()`, which only
   * wants the job names.
   */
  entries(occurrenceMs?: number): readonly TaskEnqueueEntry[];
  /**
   * Fire this task's declared entries now, through the same facade `JobHandle.enqueue` uses —
   * the backfill and "run it again" path, with no scheduler and no leader involved.
   */
  enqueue(options?: EnqueueOptions): Promise<readonly TaskJobResult[]>;
  describe(): TaskDescriptor;
}

const registry = new Map<string, TaskHandle>();
let anonymous = 0;

/** Occurrences one round may fire when neither the declaration nor a catch-up says otherwise. */
const DEFAULT_MAX_CATCH_UP = 10;

/** Job's store, for tasks: proof `task()` built the handle, plus whether it named itself. */
interface TaskOrigin {
  readonly declaredName: boolean;
  /** The export name already stamped, once one has been. `undefined` while still provisional. */
  readonly exportName?: string;
}

const origin = new WeakMap<object, TaskOrigin>();

export function task(definition: TaskDefinition): TaskHandle {
  anonymous += 1;
  const name = definition.name ?? `anonymous-task-${anonymous}`;
  // Runtime backstop; the type already makes an omitted tz a build error.
  assert(
    typeof definition.tz === 'string' && definition.tz.length > 0,
    `task "${name}" needs an explicit IANA tz — a cron without a timezone is a bug`,
    `add tz to task("${name}"), e.g. tz: 'UTC' — an unzoned cron silently drifts by an hour at every DST transition`,
  );
  // A non-empty string is not a timezone. `tz: 'Bogota'` would otherwise resolve every
  // occurrence in UTC and the cron would run five hours off, silently, forever. `time`'s
  // validator and not a local `Intl` probe: ES2024 `Intl` ACCEPTS `'+02:00'`, and a fixed offset
  // carries no DST rules — the one thing a cron's timezone exists to supply. One validator means
  // a zone `task()` accepts is a zone `@ultimat3/time` can then do arithmetic in.
  assert(
    isValidTimeZone(definition.tz),
    `task "${name}" has tz "${definition.tz}", which is not a zone in the IANA tz database`,
    `use the full zone id on task("${name}"), e.g. tz: 'America/Bogota' — list the valid ones with: bun -e "console.log(Intl.supportedValuesOf('timeZone').join('\\n'))"`,
  );

  // `maxCatchUp: 0` is not "no ceiling" — `occurrencesSince` walks
  // `for (let i = 0; i < handle.maxCatchUp; i += 1)`, so zero (and any negative, and any fraction
  // below one) returns an empty list on every round and the task NEVER fires: no error, no log
  // line, no queue row, forever. Refused where it is written, exactly as `job()` refuses
  // `concurrency: 0` and `createPacer` refuses `rate: 0`. `Number.isInteger` covers `NaN` and
  // `Infinity` in the same predicate — an unbounded catch-up is a burst nobody declared.
  assert(
    definition.maxCatchUp === undefined ||
      (Number.isInteger(definition.maxCatchUp) && definition.maxCatchUp >= 1),
    `task "${name}" declares maxCatchUp ${String(definition.maxCatchUp)}, so no occurrence can ever fire`,
    `set a whole maxCatchUp of 1 or more on task("${name}"), or omit the field for the default of ${DEFAULT_MAX_CATCH_UP}`,
  );

  const handle: TaskHandle = {
    kind: 'task',
    name,
    cron: definition.cron,
    tz: definition.tz,
    catchUp: definition.catchUp ?? 'skip',
    maxCatchUp: definition.maxCatchUp ?? DEFAULT_MAX_CATCH_UP,
    // `nowMs()` and not `Date.now()`: every reading of time in this package goes through a
    // Clock so a frozen one cannot be bypassed.
    entries: (occurrenceMs: number = nowMs()) => definition.enqueue(occurrenceMs),
    async enqueue(options?: EnqueueOptions): Promise<readonly TaskJobResult[]> {
      const fired: TaskJobResult[] = [];
      for (const [handleForJob, input] of handle.entries()) {
        // The job's PLAIN key, deliberately not `dispatch()`'s `task:occurrence:key`: that one
        // is occurrence-scoped so two schedulers cannot double-fire the same tick, and reusing
        // it here would make a manual run dedupe against whichever occurrence it landed in.
        fired.push({ job: handleForJob.name, result: await handleForJob.enqueue(input, options) });
      }
      return fired;
    },
    // Reads `handle`, never the captured `name`: `nameTasks()` rebinds the property in place.
    describe(): TaskDescriptor {
      return {
        kind: 'task',
        name: handle.name,
        cron: handle.cron,
        tz: handle.tz,
        catchUp: handle.catchUp,
        maxCatchUp: handle.maxCatchUp,
        // Declaration order: a task's entries are a sequence, not a set.
        jobs: handle.entries().map(([entry]) => entry.name),
      };
    },
  };
  origin.set(handle, { declaredName: definition.name !== undefined });
  // Refused here, not at `registerTask`: a second `task({ name: 'nightly' })` would otherwise
  // replace the seated handle, and the scheduler's persisted `lastFiredAt` — keyed by that name —
  // would silently start driving a different cron. The anonymous names cannot collide.
  if (registry.has(name)) throw new JobNameTakenError({ kind: 'task', name });
  registry.set(name, handle);
  return handle;
}

/** Structural, exactly as `isJobHandle` is: only a handle `task()` built has a cron behind it. */
export function isTaskHandle(value: unknown): value is TaskHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'task' &&
    origin.has(value)
  );
}

/**
 * Register `target` under `name`, stamped onto the handle the module exported — the scheduler's
 * occurrence key is `task:occurrenceMs:jobKey`, so the task's name is what stops two nodes
 * double-firing a tick, and a copy under a second name would defeat it.
 *
 * A definition that supplied its own `name` keeps it, for the same reason a job's does: the
 * scheduler's persisted `lastFiredAt` is keyed by that name.
 */
export function registerTask(name: string, target: TaskHandle): TaskHandle {
  const source = origin.get(target);
  const key = source?.declaredName === true ? target.name : name;
  const seated = registry.get(key);
  // The same handle under the same name is one registration seen twice — `defineApi` and the
  // framework's module scan both reach the same declaration file. A DIFFERENT task under a taken
  // name is the ambiguity to refuse.
  if (seated !== undefined) {
    if (seated !== target) throw new JobNameTakenError({ kind: 'task', name: key });
    return target;
  }
  // One handle exported under two names: the rebind below is in place, so the second alias would
  // move the occurrence key the scheduler dedupes ticks on.
  if (source?.exportName !== undefined && source.exportName !== key)
    throw new JobNameTakenError({ kind: 'task', name: key });
  registry.delete(target.name);
  Object.defineProperty(target, 'name', { value: key, configurable: true });
  if (source !== undefined) origin.set(target, { ...source, exportName: key });
  registry.set(key, target);
  return target;
}

/** `registerTasks(module)` is the call app code makes; this is the same rules over a record. */
export function nameTasks(record: Readonly<Record<string, TaskHandle>>): void {
  for (const [exportName, handle] of Object.entries(record)) registerTask(exportName, handle);
}

/**
 * Code-unit compare, never `localeCompare`. This list is projected into `x.manifest.json`, which
 * both tracked apps COMMIT and `x verify`'s drift step diffs byte for byte — and `localeCompare`
 * with no locale argument answers from the runtime's ICU default and collation version, so the
 * same source could sort two ways on two machines. `@ultimat3/http`'s `describeRoutes` states the
 * same rule; the comparator is restated rather than imported because `http` is not below this
 * package on the tier table.
 */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function registeredTasks(): readonly TaskHandle[] {
  return [...registry.values()].sort((a, b) => byName(a.name, b.name));
}

export function getTask(name: string): TaskHandle | undefined {
  return registry.get(name);
}

export function resetTasks(): void {
  registry.clear();
  anonymous = 0;
}
