// The X_* codes owned by @ultimat3/notify. Each names the exact change that resolves it.
//
// No `docs:` line, and that is deliberate: `UltimateError`'s constructor resolves the registered
// descriptor, whose default is `ERROR_DOCS_URL` in @ultimat3/core. A URL written out here is a
// second answer to a question core already answers, and the last one went stale host and all.
import {
  registerErrorCodes,
  registerErrorRetry,
  renderThrowable,
  UltimateError,
} from '@ultimat3/core';

export const NOTIFY_ERROR_CODES = [
  'X_NOTIFY_CHANNELS_EMPTY',
  'X_NOTIFY_CHANNEL_DUPLICATE',
  'X_NOTIFY_FANOUT_TOO_WIDE',
  'X_NOTIFY_STORE_MISSING',
  'X_NOTIFY_DELIVERY_FAILED',
  'X_NOTIFY_DIGEST_UNSUPPORTED',
] as const;

export type NotifyErrorCode = (typeof NOTIFY_ERROR_CODES)[number];

export const NOTIFY_ERROR_TITLES: Readonly<Record<NotifyErrorCode, string>> = {
  X_NOTIFY_CHANNELS_EMPTY: 'the notifier declares no channels',
  X_NOTIFY_CHANNEL_DUPLICATE: 'two deliveries share one channel name',
  X_NOTIFY_FANOUT_TOO_WIDE: 'the audience is larger than one run may fan out to',
  X_NOTIFY_STORE_MISSING: 'a channel needs a store nothing installed',
  X_NOTIFY_DELIVERY_FAILED: 'a channel did not accept the delivery',
  X_NOTIFY_DIGEST_UNSUPPORTED: 'a digest window is declared on a bulk channel',
};

// One unconditional call, so a second package claiming one of notify's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(NOTIFY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The codes of this package's that can be thrown INSIDE a notifier's run, classified.
 * `executeJob` reads this through `nextRetryForError`, which short-circuits on `terminal` and on
 * NOTHING else — so an unclassified code falls through to the attempt count and spends the whole
 * policy re-proving an answer that cannot change. `classifyThrown` reads an unregistered code as
 * unclassified even when its instance carries `terminal`, which is why this has to be explicit
 * rather than left to `DEFAULT_ERROR_RETRY`.
 *
 * Both terminal ones were live defects until 2026-08-24: an audience of 900 against
 * `maxRecipients: 500` re-resolved the audience and re-counted it once per attempt, and a missing
 * inbox store dead-lettered five attempts later than it knew the answer.
 *
 * THE THREE DECLARATION-TIME CODES ARE DELIBERATELY ABSENT, and that is the audit rather than an
 * omission. `X_NOTIFY_CHANNELS_EMPTY`, `X_NOTIFY_CHANNEL_DUPLICATE` and
 * `X_NOTIFY_DIGEST_UNSUPPORTED` are all thrown by `resolve()` inside `notifier()`, which runs at
 * module load — the worker is not running, `classifyThrown` is never reached, and a row for them
 * would be a claim nothing reads. `errors.test.ts` pins the split both ways, so a code that moves
 * from one side to the other fails a test rather than going quiet.
 */
registerErrorRetry({
  // The audience is what it is. Retrying counts it again and refuses again — and each attempt
  // re-runs `recipientsFor`, so the policy is spent on repeated work as well as repeated time.
  X_NOTIFY_FANOUT_TOO_WIDE: 'terminal',
  // A store is installed at boot or it is not. No attempt of a running worker installs one.
  X_NOTIFY_STORE_MISSING: 'terminal',
  // The one a retry can fix: a provider blip, a timeout, a 503. It read correctly before this
  // block existed only because `unclassified` happens to fall through to the attempt count —
  // declaring it is what makes that an answer rather than a coincidence, and what stops a later
  // sweep through this file from making the whole package terminal.
  X_NOTIFY_DELIVERY_FAILED: 'retryable',
});

/** Refused where it is written: a notifier with no channel is a job that fans out to nobody. */
export class NotifyChannelsEmptyError extends UltimateError {
  constructor(input: { notifier: string }) {
    super({
      code: 'X_NOTIFY_CHANNELS_EMPTY',
      cause: `notifier "${input.notifier}" declares no channels, so every run resolves recipients and delivers nothing`,
      fix: `add at least one entry to deliver: [] on notifier("${input.notifier}") — inAppChannel() is the one with no external driver`,
      meta: { notifier: input.notifier },
    });
  }
}

/**
 * Two deliveries on one notifier naming the same channel. Refused because the ledger's unique key
 * is `(notifier, key, channel, coalesce(recipient, ''))` (`ledger-pg.ts`, and `SQL_NOTIFY_CLAIM`'s
 * `on conflict` spells the same expression): the second delivery would claim a row the first
 * already owns and be dropped as a duplicate, so one of the two would silently never send.
 *
 * The `coalesce` is the load-bearing half and is not a detail. A bulk delivery claims with a NULL
 * recipient, and NULLs are DISTINCT in a plain unique index — so without it a bulk claim would be
 * claimable without bound and every replay would re-send the whole audience. Stating the key
 * without it is what invites the "simplification" that puts the bug back.
 */
export class NotifyChannelDuplicateError extends UltimateError {
  constructor(input: { notifier: string; channel: string }) {
    super({
      code: 'X_NOTIFY_CHANNEL_DUPLICATE',
      cause: `notifier "${input.notifier}" declares the channel "${input.channel}" twice, and the delivery ledger keys on it — the second would be deduped away`,
      fix: `give the second channel its own name on notifier("${input.notifier}") — channel('${input.channel}-digest', …) — or merge the two deliver entries`,
      meta: { notifier: input.notifier, channel: input.channel },
    });
  }
}

/**
 * One step per recipient is what makes a provider blip re-send one address rather than all of
 * them, and a step is a durable row — so the fan-out has a width past which it is the wrong shape
 * entirely. Refused with a number rather than degraded silently.
 */
export class NotifyFanoutTooWideError extends UltimateError {
  constructor(input: { notifier: string; recipients: number; max: number }) {
    super({
      code: 'X_NOTIFY_FANOUT_TOO_WIDE',
      cause: `notifier "${input.notifier}" resolved ${String(input.recipients)} recipients and the per-run ceiling is ${String(input.max)} — each one is a durable step row`,
      fix: `deliver through a bulkChannel() on notifier("${input.notifier}"), which sends one payload for every recipient, or page the audience with backfill() from @ultimat3/jobs`,
      meta: { notifier: input.notifier, recipients: input.recipients, max: input.max },
    });
  }
}

/**
 * A channel or a window asked for a store nothing installed.
 *
 * The delivery ledger is deliberately NOT one of these: it has a correct-for-one-process default
 * (`createMemoryDeliveryLedger`), the way every other driver seam in this framework does. An inbox
 * and a digest window have no such default — there is nowhere to put the row — so they refuse.
 */
export class NotifyStoreMissingError extends UltimateError {
  constructor(input: { notifier: string; store: 'inbox' | 'digest' }) {
    const what =
      input.store === 'inbox' ? 'a channel that writes the in-app inbox' : 'a digest window';
    const install =
      input.store === 'inbox'
        ? 'createMemoryInboxStore() }) at boot, or createPgInboxStore({ executor }) to share it across replicas'
        : 'createMemoryDigestStore() }) at boot';
    super({
      code: 'X_NOTIFY_STORE_MISSING',
      cause: `notifier "${input.notifier}" delivers through ${what} and no ${input.store} store is installed, so the rows have nowhere to go`,
      fix: `call setNotifyStores({ ${input.store}: ${install}`,
      meta: { notifier: input.notifier, store: input.store },
    });
  }
}

/**
 * A digest window declared on a bulk channel. Refused where it is written: a bulk send has one
 * payload for the whole audience and a window coalesces PER RECIPIENT, so the two have no shared
 * meaning — and inventing one would be this package deciding whose events get grouped.
 */
export class NotifyDigestUnsupportedError extends UltimateError {
  constructor(input: { notifier: string; channel: string }) {
    super({
      code: 'X_NOTIFY_DIGEST_UNSUPPORTED',
      cause: `notifier "${input.notifier}" declares a digest window on the bulk channel "${input.channel}", and a window coalesces per recipient where a bulk send has none`,
      fix: `drop digest from the "${input.channel}" entry on notifier("${input.notifier}") and give it a wait instead, or deliver it through channel('${input.channel}', …) one recipient at a time`,
      meta: { notifier: input.notifier, channel: input.channel },
    });
  }
}

/**
 * A channel's `deliver` threw. Wrapped rather than rethrown so the dead-letter row carries a
 * stable code and names the channel — a raw provider error names only itself.
 *
 * `renderThrowable` and never `${cause}`: a caught value is annotated by nobody, and a provider
 * rejection is routinely an object whose `toString` throws (`bun run scripts/catch-render.ts`).
 */
export class NotifyDeliveryFailedError extends UltimateError {
  constructor(input: { notifier: string; channel: string; recipients: number; cause: unknown }) {
    super({
      code: 'X_NOTIFY_DELIVERY_FAILED',
      cause: `channel "${input.channel}" of notifier "${input.notifier}" failed for ${String(input.recipients)} recipient(s): ${renderThrowable(input.cause)}`,
      // `x jobs ls` first, and never `x jobs show` handed a notifier NAME: that command takes a job id
      // positional and resolves it through `inspectJob`, which answers `X_JOB_UNKNOWN` for
      // anything else — so a notifier NAME made the one command this refusal printed fail every
      // time it was run. A `fix:` that fails is worse than none, because the reader spends their
      // trust on it before finding out. The two-step shape is what `wiki/Error-Codes.md` already
      // documents for this code.
      fix: `x jobs ls --json   # find the run, then: x jobs show <id> --json — the failing step is deliver:${input.channel}`,
      meta: { notifier: input.notifier, channel: input.channel },
    });
  }
}
