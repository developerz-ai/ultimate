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

/** A job became claimable on the queue the payload names. An empty payload means any queue. */
export const JOBS_WAKE_CHANNEL = 'x_jobs_wake';
/** A row was committed to `x_outbox`. The payload is always empty: a relay serves every queue. */
export const OUTBOX_WAKE_CHANNEL = 'x_outbox_wake';

/**
 * One notification per queue per slot, at most — whatever the enqueue rate. It equals the
 * worker's default poll floor on purpose: a woken worker polls again one floor later, so a row
 * that stayed silent because its slot had already spoken is found by that pass. Enqueue latency
 * is therefore never worse than the fixed 250 ms poll this replaced.
 */
export const WAKE_SLOT_MS = 250;

/**
 * A row due this soon still notifies. `run_at` is stamped from the ENQUEUER's clock, so a pod
 * running a few hundred ms ahead of the database writes "immediate" jobs that are due a moment
 * from now — and the passes a woken worker makes (0, 250, 750 ms) are what pick those up.
 */
export const WAKE_DUE_WITHIN_MS = 1_000;

const SLOTS_PER_SECOND = 1_000 / WAKE_SLOT_MS;

/**
 * `pg_notify` for the row `alias` names, or nothing: the row must be (about to be) due, and no
 * OTHER row of its queue may have been created in the current slot. The statement's own insert
 * is invisible to this read — a CTE's writes are not in its statement's snapshot — so the row
 * never silences itself. Read over `x_jobs_created_idx`, newest first, stopping at the slot.
 */
export const notifyJobReady = (alias: string): string => `
       (select pg_notify('${JOBS_WAKE_CHANNEL}', ${alias}.queue)
         where ${alias}.run_at <= now() + interval '${WAKE_DUE_WITHIN_MS} milliseconds'
           and not exists (
             select 1 from x_jobs o
              where o.queue = ${alias}.queue
                and o.created_at >= to_timestamp(
                      floor(extract(epoch from now()) * ${SLOTS_PER_SECOND}) / ${SLOTS_PER_SECOND})
           ))`;

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
