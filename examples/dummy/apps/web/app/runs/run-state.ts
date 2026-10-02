/**
 * What a run IS, read off its events — pure, so the console, the states file and a test all
 * derive one answer. The browser half of the feature's vocabulary: no server module is imported
 * here, only types the compiler erases.
 *
 * A run's state is its LAST event. Nothing is stored for it: the events are the record, and a
 * state column beside them is a second answer to keep in step.
 */

import type { RunEventKind, RunUsage } from '@postly/db';
import type { Row } from '@ultimat3/realtime';
import type { Api } from '../../api';

/** What `useQuery` subscribes under. `defineApi` names a query after its export, so this is it. */
export const LIVE_RUN_EVENTS: keyof Api['queries'] = 'liveRunEvents';

/** One event as the socket carries it — JSON, so `at` is an ISO instant, never a `Date`. */
export interface RunEventRow extends Row {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly at: string;
  readonly message: string;
  readonly prompt: number | null;
  readonly usage: RunUsage | null;
}

/** The five things a console can be showing. `idle` is not one: that is no run at all. */
export const CONSOLE_STATES = ['pending', 'streaming', 'awaiting', 'failed', 'done'] as const;
export type ConsoleState = (typeof CONSOLE_STATES)[number];

/**
 * In `seq` order, one row per `seq`. A patch redelivered after a reconnect carries a `seq` the
 * list already holds, and the first one wins. `seq` starts at 1, so anything below it is not an
 * event of this feature and is dropped — said here, where the reader is, as well as in the CHECK.
 */
export function orderedEvents(rows: readonly RunEventRow[]): readonly RunEventRow[] {
  const bySeq = new Map<number, RunEventRow>();
  for (const row of rows) {
    if (row.seq >= 1 && !bySeq.has(row.seq)) bySeq.set(row.seq, row);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** A phase moves the console; `usage` is what an ended run used, and moves nothing. */
export type Phase = Exclude<RunEventKind, 'usage'>;

const STATE_OF: Readonly<Record<Phase, ConsoleState>> = {
  prompt: 'awaiting',
  answered: 'streaming',
  navigated: 'streaming',
  extracted: 'streaming',
  done: 'done',
  failed: 'failed',
};

/** The run's last PHASE event: what the run is doing, whatever was recorded about it after. */
const lastPhase = (events: readonly RunEventRow[]): (RunEventRow & { kind: Phase }) | undefined =>
  events.findLast((event): event is RunEventRow & { kind: Phase } => event.kind !== 'usage');

/** `pending` until the first event: the run is queued, or a worker has not reached it yet. */
export function consoleState(events: readonly RunEventRow[]): ConsoleState {
  const last = lastPhase(events);
  return last === undefined ? 'pending' : STATE_OF[last.kind];
}

/** Which prompt the run is waiting on — `null` unless its last phase is the question itself. */
export function waitingPrompt(events: readonly RunEventRow[]): number | null {
  const last = lastPhase(events);
  return last?.kind === 'prompt' ? last.prompt : null;
}

/** What the run used, once it ended and said so — `null` before. */
export function runUsage(events: readonly RunEventRow[]): RunUsage | null {
  return events.findLast((event) => event.kind === 'usage')?.usage ?? null;
}

/** The connection was busy: another run held it, and this one never started. */
export const BUSY_CODE = 'X_JOB_KEY_BUSY';

/** A run that can still be cancelled: anything short of an ending. */
export const isLive = (state: ConsoleState): boolean => state !== 'done' && state !== 'failed';
