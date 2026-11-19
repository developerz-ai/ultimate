// The cross-process wake, as SQL: the two channels a worker pod LISTENs on, and the fragments that
// decide whether a statement announces the row it wrote.
//
// A NOTIFY is part of its transaction — it is delivered when that commits and never when it rolls
// back — which is what lets the enqueue and the outbox stage carry one. The payload is the QUEUE
// NAME and nothing else: never an id, an input or a tenant, because every session listening reads
// it.
//
// Why a statement does not always notify: Postgres serialises the commit of every transaction
// that issued a NOTIFY behind one lock, held through that commit's WAL flush. A notification per
// enqueue would cap an app's enqueuing commits at one flush at a time. So each statement asks
// first whether the loops it would wake are already awake.

import { IDLE_REST_MAX_MS, WAKE_SLOT_MS } from './idle-backoff';

/** A job became claimable on the queue the payload names. An empty payload means any queue. */
export const JOBS_WAKE_CHANNEL = 'x_jobs_wake';
/** A row was committed to `x_outbox`. The payload is always empty: a relay serves every queue. */
export const OUTBOX_WAKE_CHANNEL = 'x_outbox_wake';

/**
 * The payload of a listener's RE-PROOF (`queue-wake.ts`): a notification that asks only whether
 * the session still delivers, and wakes no loop. A control character leads it, so no queue is
 * ever named it; a pod from before it reads an unknown queue on the jobs channel and passes once
 * on the outbox one.
 */
export const WAKE_REPROVE_PAYLOAD = '\u0001reprove';

/**
 * One notification per queue per slot, whatever the enqueue rate — save the first commits of a
 * slot racing each other, which may each send one (`notifyJobReady`). Declared beside the loops
 * that honour it (`idle-backoff.ts`): a woken loop keeps passing until a slot has gone by since
 * its wake, whatever its floor, so a row that stayed silent because its slot had already spoken
 * is found by a pass behind the slot's end: within one backoff step of that end — one floor at the
 * default 250 ms floor — and never a rest. The one row this does not cover is named under
 * `notifyJobReady`; there the bound is the rest (`IDLE_REST_MAX_MS`).
 */
export { WAKE_SLOT_MS };

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
 * Silence is sound only when this row commits before the worker the other row woke settles, a
 * slot or more after that wake (`IdleBackoff.settled`). A transaction that began before the
 * clock's slot may commit any time later, and a slot read off its `now()` spans every row created
 * since: it always notifies.
 * Otherwise `now()` IS in the clock's slot, so the read bounds `created_at` by `now()`'s slot — the
 * same bound, as a stable expression the planner estimates; off the volatile clock it is a param
 * guessed at a third of the table, and `x_jobs_created_idx` loses to a scan.
 *
 * Still silent: a transaction that enqueues in its first slot, then runs past the woken worker's
 * settling before it commits — no statement sees its own commit. The boot's driver enqueues on
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
 * The advisory lock (two-key form, so it never meets an app's one-key `bigint` locks) a SILENCED
 * stage holds, shared, until its transaction ends. Shared holders never wait on each other.
 */
export const OUTBOX_STAGING_LOCK = '2020570484, 1'; // 0x786f7574, 'xout'

/**
 * `pg_notify` for a staged row, unless a committed row is already waiting unclaimed: the relay
 * that row woke is about to pass, or is passing at its floor. A row a relay HOLDS does not count —
 * its holder may be dead, and its lease is not a wake.
 *
 * The silence is decided at the STAGE, but the relay finds the row only at its COMMIT, which a
 * request transaction may reach any time later — after the relay claimed the other row, made its
 * passes and went to rest — 60 s (the audit's repro, 2026-11-16). So a silenced stage takes
 * `OUTBOX_STAGING_LOCK` shared instead, held until it commits or rolls back; an idle relay's claim
 * tries it (`SQL_OUTBOX_CLAIM_IDLE`'s `staging`), and while it is held the relay keeps polling on
 * its backoff and never rests (`postgresOutboxStore`'s `quiet`).
 *
 * Why not notify every stage: `NOTIFY` serialises every notifying commit in the cluster behind one
 * lock (the header), and a stage is inside an app's own transaction. A shared advisory lock costs
 * one lock-table entry and conflicts only with an idle claim's try, for the rest of that claim.
 * `woke` is `''` when it notified and `null` when it did not, as before.
 *
 * READ COMMITTED only: there the read is this statement's, taken now. A repeatable-read or
 * serializable snapshot may predate the relay claiming the other row — the stage sees it waiting,
 * goes silent, and the relay that claimed it is already resting, trying no lock: it notifies.
 * What stays silent at read committed: a single stage statement that stalls between its snapshot
 * and its lock past the relay's claim of the other row AND the idle passes behind it (at least
 * `WAKE_SLOT_MS`, `IdleBackoff.settled`) — then its row waits out the rest (`IDLE_REST_MAX_MS`).
 */
export const NOTIFY_STAGED = `
       (select case when s.silent
                    then nullif(pg_advisory_xact_lock_shared(${OUTBOX_STAGING_LOCK})::text, '')
                    else pg_notify('${OUTBOX_WAKE_CHANNEL}', '')::text end
          from (select exists (
                  select 1 from x_outbox o where o.published_at is null and o.claimed_at is null
                ) and current_setting('transaction_isolation') = 'read committed'
                as silent) s)`;

/**
 * An unconditional wake: an operator's requeue, promote or resume, and the listener's own probe.
 * $1 channel, $2 payload.
 */
export const SQL_WAKE = 'select pg_notify($1, $2)';
