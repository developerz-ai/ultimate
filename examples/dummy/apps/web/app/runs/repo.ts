/**
 * The only module that reads or writes `connections`, `runs` and `run_events`. Every statement goes
 * through the typed handle, so there is no SQL text here and no org to pass: the handle scopes
 * each read to the ACTING actor's org and refuses a row that names another.
 *
 * `credential` is sealed by the handle on the way in and opened on the way out; nothing here
 * handles ciphertext, and no function here may filter on it.
 */

import {
  type Connection,
  db,
  type Run,
  type RunEvent,
  type RunEventKind,
  type RunStatus,
  type RunUsage,
} from '@postly/db';

export function connectionById(id: string): Promise<Connection | null> {
  return db.connections.where({ id }).one();
}

/** Newest first and bounded: an unordered page is a different page on every request. */
export function listConnections(limit: number): Promise<readonly Connection[]> {
  return db.connections.orderBy('createdAt', 'desc').limit(limit).all();
}

export function insertConnection(row: {
  readonly orgId: string;
  readonly label: string;
  readonly credential: string;
  readonly exit: string | null;
}): Promise<Connection> {
  // Each column NAMED, the sealed one included: a spread of a row drops `credential`, which is
  // not enumerable, and the insert is then refused for the column it lost.
  return db.connections.insert({
    orgId: row.orgId,
    label: row.label,
    credential: row.credential,
    exit: row.exit,
  });
}

/** A run, `queued`, under the ids the queue allocated when `startRun` staged its job. */
export function insertRun(row: {
  readonly id: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly jobId: string;
}): Promise<Run> {
  return db.runs.insert({ ...row, status: 'queued', code: null });
}

export function runById(id: string): Promise<Run | null> {
  return db.runs.where({ id }).one();
}

/** One run's events in the order they happened. The handle appends `id`, so the order is total. */
export function eventsOf(runId: string, limit: number): Promise<readonly RunEvent[]> {
  return db.runEvents.where({ runId }).orderBy('seq').limit(limit).all();
}

/** The `prompt` row a given answer is for, or `null` when the run asked no such question. */
export function promptEvent(runId: string, prompt: number): Promise<RunEvent | null> {
  return db.runEvents
    .where({ runId, kind: 'prompt', prompt })
    .orderBy('seq', 'desc')
    .limit(1)
    .one();
}

export interface NewRunEvent {
  readonly orgId: string;
  readonly runId: string;
  readonly kind: RunEventKind;
  readonly message: string;
  readonly prompt?: number;
  readonly usage?: RunUsage;
}

/** The run's status each event leaves it in. `usage` is not a phase: it moves nothing. */
export const STATUS_AFTER: Readonly<Record<RunEventKind, RunStatus | null>> = {
  prompt: 'running',
  answered: 'running',
  navigated: 'running',
  extracted: 'running',
  done: 'done',
  failed: 'failed',
  usage: null,
};

/**
 * Append one event under the next `seq` — the last one plus one, so the first is 1 — and move the
 * run's `status` to what that event says. One writer for both, so the projection cannot drift
 * from the record. A run has one writer at a time (one attempt, on one worker), and
 * `run_event_seq_unique` refuses the write that would break that rather than letting two events
 * share a number.
 *
 * Event first, status second, and not one transaction: a worker's body holds none, and the event
 * is the record. A status left behind by a failed second statement is moved on by the next event.
 * Every run has its row — `startRun` writes it, and `run_events.run_id` references it — so an
 * event for a run with none is refused here, as the foreign key refuses it in Postgres.
 */
export async function appendEvent(event: NewRunEvent): Promise<RunEvent> {
  const last = await db.runEvents
    .where({ runId: event.runId })
    .orderBy('seq', 'desc')
    .limit(1)
    .one();
  const appended = await db.runEvents.insert({
    orgId: event.orgId,
    runId: event.runId,
    seq: (last?.seq ?? 0) + 1,
    kind: event.kind,
    message: event.message,
    prompt: event.prompt ?? null,
    usage: event.usage ?? null,
  });
  const status = STATUS_AFTER[event.kind];
  if (status !== null) {
    // A failed run's message IS its `X_*` code; nothing else ends with one. By id because it IS
    // one row by its key: the change names that row, so a live window over `runs` is patched in
    // place. A filtered write (`updateWhere`) would be correct too — it stales only the windows
    // reading `runs`, which re-read and re-snapshot on their next change — but it buys a re-read
    // for a row this statement already names.
    const code = status === 'failed' ? event.message : null;
    await db.runs.update(event.runId, { status, code });
  }
  return appended;
}
