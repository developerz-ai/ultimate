// The cross-process wake, as SQL: the two channels a worker pod LISTENs on, and the fragments that
// decide whether a statement announces the row it wrote. A NOTIFY is part of its transaction — it
// is delivered when that commits and never when it rolls back — which is what lets the enqueue
// and the outbox stage carry one. The payload is the QUEUE NAME and nothing else: never an id, an
// input or a tenant, because every session listening reads it.
//
// Why a statement does not always notify: Postgres serialises the commit of every transaction
// that issued a NOTIFY behind one lock, held through that commit's WAL flush. A notification per
// enqueue would cap an app's enqueuing commits at one flush at a time. So each statement asks
// first whether the loops it would wake are already awake.

import { IDLE_REST_MAX_MS } from './idle-backoff';

/** A job became claimable on the queue the payload names. An empty payload means any queue. */
export const JOBS_WAKE_CHANNEL = 'x_jobs_wake';
/** A row was committed to `x_outbox`. The payload is always empty: a relay serves every queue. */
export const OUTBOX_WAKE_CHANNEL = 'x_outbox_wake';

/**
 * One notification per queue per slot, whatever the enqueue rate — save the first commits of a
 * slot racing each other, which may each send one (`notifyJobReady`). It equals the worker's
 * default poll floor on purpose: a woken worker polls again one floor later, so a row
 * that stayed silent because its slot had already spoken is found by that pass. Enqueue latency
 * is therefore never worse than the fixed 250 ms poll this replaced.
 */
export const WAKE_SLOT_MS = 250;

/**
 * A row due this soon still notifies: as far out as an idle worker RESTS (`IDLE_REST_MAX_MS`). A
 * resting worker sleeps on the due time its last empty claim read, so a row queued during the rest
 * and due before it ends must wake it to re-read that horizon — the pass it wakes for is empty,
 * and it then rests until the new row is due. Further out, the rest ends first and its own pass
 * learns the time. The slot still bounds the notifications, whatever the due times.
 */
export const WAKE_DUE_WITHIN_MS = IDLE_REST_MAX_MS;

const SLOTS_PER_SECOND = 1_000 / WAKE_SLOT_MS;

/** A row due this soon is one that notified when it was written — the test both sides share. */
const dueSoon = (alias: string): string =>
  `${alias}.run_at <= clock.at + interval '${WAKE_DUE_WITHIN_MS} milliseconds'`;

/** The start of the slot the instant `at` is in. */
const slotStart = (at: string): string =>
  `to_timestamp(floor(extract(epoch from ${at}) * ${SLOTS_PER_SECOND}) / ${SLOTS_PER_SECOND})`;

/**
 * `pg_notify` for the row `alias` names, or nothing: the row must be due within a rest, and no
 * OTHER row of its queue that was itself due soon may have been created in the current slot. Only
 * such a row sent a wake — a far-future one sent none, so it silences nothing. The statement's own
 * insert is invisible to this read — a CTE's writes are not in its statement's snapshot — so the
 * row never silences itself. Read over `x_jobs_created_idx`, newest first, stopping at the slot.
 *
 * Decided on the WALL CLOCK (`clock_timestamp()`), because `now()` is when the TRANSACTION began.
 * Silence is sound only when this row commits before the worker the other row woke polls again, a
 * floor after that wake. A transaction that began before the clock's slot may commit any time
 * later, and a slot read off its `now()` spans every row created since: it always notifies.
 * Otherwise `now()` IS in the clock's slot, so the read bounds `created_at` by `now()`'s slot — the
 * same bound, as a stable expression the planner estimates; off the volatile clock it is a param
 * guessed at a third of the table, and `x_jobs_created_idx` loses to a scan.
 *
 * Still silent: a transaction that enqueues in its first slot, then runs past the woken worker's
 * next pass before it commits — no statement sees its own commit. The boot's driver enqueues on
 * the pool, never inside an app transaction (that is the outbox, `NOTIFY_STAGED`), so only an
 * executor an app binds to its own transaction meets it.
 *
 * A read, not a reservation: two first-of-slot enqueues committing together can both notify. A
 * spare wake costs one commit behind the NOTIFY lock; a slot row to reserve would put EVERY enqueue
 * behind one row lock, which is the serialisation this exists to avoid.
 */
export const notifyJobReady = (alias: string): string => `
       (select pg_notify('${JOBS_WAKE_CHANNEL}', ${alias}.queue)
          from (select clock_timestamp() as at) clock
         where ${dueSoon(alias)}
           and (now() < ${slotStart('clock.at')}
             or not exists (
               select 1 from x_jobs o
                where o.queue = ${alias}.queue
                  and o.created_at >= ${slotStart('now()')}
                  and ${dueSoon('o')}
             )))`;

/**
 * `pg_notify` for a staged row, unless a committed row is already waiting unclaimed: the relay
 * that row woke is about to pass, or is passing at its floor, and finds this one too. A row a
 * relay HOLDS does not count — its holder may be dead, and its lease is not a wake.
 */
export const NOTIFY_STAGED = `
       (select pg_notify('${OUTBOX_WAKE_CHANNEL}', '')
         where not exists (
           select 1 from x_outbox o where o.published_at is null and o.claimed_at is null
         ))`;

/**
 * An unconditional wake: an operator's requeue, promote or resume, and the listener's own probe.
 * $1 channel, $2 payload.
 */
export const SQL_WAKE = 'select pg_notify($1, $2)';
