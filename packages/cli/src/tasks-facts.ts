// Pure fact-gathering behind `x tasks`: registered task descriptors plus their next
// occurrence(s), computed from `@ultimat3/time`'s cron math against an injected `nowMs` — never
// the wall clock — so a test drives every DST edge with no CLI parsing and no rendering involved.

import type { TaskDescriptor, TaskHandle } from '@ultimat3/jobs';
import { getTask, registeredTasks } from '@ultimat3/jobs';
import type { CronPhrases } from '@ultimat3/time';
import { describeCron, fromEpochMs, isoInZone, nextCronOccurrenceMs } from '@ultimat3/time';
import { BadFlagError } from './errors';

const DEFAULT_COUNT = 5;
const MAX_COUNT = 50;

/** `x tasks list` row: the descriptor plus the next occurrence, ms and rendered alike. */
export interface TaskFact extends TaskDescriptor {
  readonly nextMs: number;
  readonly next: string;
}

function toFact(handle: TaskHandle, nowMs: number): TaskFact {
  const descriptor = handle.describe();
  const nextMs = nextCronOccurrenceMs(descriptor.cron, descriptor.tz, nowMs);
  return { ...descriptor, nextMs, next: isoInZone(fromEpochMs(nextMs), descriptor.tz) };
}

export function listTaskFacts(nowMs: number): readonly TaskFact[] {
  return registeredTasks().map((handle) => toFact(handle, nowMs));
}

export function knownTaskNames(): readonly string[] {
  return registeredTasks().map((handle) => handle.name);
}

export function findTaskHandle(name: string): TaskHandle | undefined {
  return getTask(name);
}

/**
 * `--count` for `x tasks show`: how many upcoming occurrences to compute. Default 5, clamped to
 * 50 — unbounded would let one `* * * * *` task turn a single command into an unbounded response.
 * Anything that is not a positive integer is refused rather than coerced, same idiom as
 * `parseLimitFlag` in `jobs-report.ts`: past `Number.MAX_SAFE_INTEGER` or with a fractional part,
 * "the number typed" and "the number used" would silently differ.
 */
export function parseCountFlag(value: string | undefined): number {
  if (value === undefined) return DEFAULT_COUNT;
  const digits = value.trim();
  const parsed = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadFlagError({
      flag: 'count',
      command: 'tasks',
      reason: `expects a positive integer, got "${value}"`,
    });
  }
  return Math.min(parsed, MAX_COUNT);
}

export interface TaskOccurrence {
  readonly ms: number;
  readonly at: string;
}

/** `x tasks show <name>`: the descriptor, the human cron phrase, and the next `count` firings. */
export interface TaskShowFacts {
  readonly descriptor: TaskDescriptor;
  readonly describe: string;
  readonly upcoming: readonly TaskOccurrence[];
}

/**
 * `phrases` is a parameter for the same reason `describeCron` demands one: this module owns cron
 * math, not words, and a vocabulary hardcoded here would be a second catalog the CLI's own
 * `messages.ts` could never translate. The caller supplies it — `cmd-tasks.ts` from `cli.cron.*`.
 */
export function taskShowFacts(
  handle: TaskHandle,
  nowMs: number,
  count: number,
  phrases: CronPhrases,
): TaskShowFacts {
  const descriptor = handle.describe();
  const upcoming: TaskOccurrence[] = [];
  let cursor = nowMs;
  for (let i = 0; i < count; i += 1) {
    cursor = nextCronOccurrenceMs(descriptor.cron, descriptor.tz, cursor);
    upcoming.push({ ms: cursor, at: isoInZone(fromEpochMs(cursor), descriptor.tz) });
  }
  return { descriptor, describe: describeCron(descriptor.cron, 'en-US', phrases), upcoming };
}
