// The X_* codes owned by @ultimat3/notify. Each names the exact change that resolves it.
//
// No `docs:` line, and that is deliberate: `UltimateError`'s constructor resolves the registered
// descriptor, whose default is `ERROR_DOCS_URL` in @ultimat3/core. A URL written out here is a
// second answer to a question core already answers, and the last one went stale host and all.
import type { ErrorRetry } from '@ultimat3/core';
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
  'X_NOTIFY_DELIVERY_HELD',
  'X_NOTIFY_PUSH_DEVICE_GONE',
  'X_NOTIFY_PUSH_PROVIDER_REFUSED',
  'X_NOTIFY_PUSH_MESSAGE_INVALID',
  'X_NOTIFY_SMS_TRANSPORT_MISSING',
  'X_NOTIFY_SMS_NUMBER_INVALID',
] as const;

export type NotifyErrorCode = (typeof NOTIFY_ERROR_CODES)[number];

export const NOTIFY_ERROR_TITLES: Readonly<Record<NotifyErrorCode, string>> = {
  X_NOTIFY_CHANNELS_EMPTY: 'the notifier declares no channels',
  X_NOTIFY_CHANNEL_DUPLICATE: 'two deliveries share one channel name',
  X_NOTIFY_FANOUT_TOO_WIDE: 'the audience is larger than one run may fan out to',
  X_NOTIFY_STORE_MISSING: 'a channel needs a store nothing installed',
  X_NOTIFY_DELIVERY_FAILED: 'a channel did not accept the delivery',
  X_NOTIFY_DIGEST_UNSUPPORTED: 'a digest window is declared on a bulk channel',
  X_NOTIFY_DELIVERY_HELD: 'another attempt holds this delivery',
  X_NOTIFY_PUSH_DEVICE_GONE: 'the push provider says a device token is dead',
  X_NOTIFY_PUSH_PROVIDER_REFUSED: 'APNs or FCM refused a push for good',
  X_NOTIFY_PUSH_MESSAGE_INVALID: 'a data-only push carries more than an id',
  X_NOTIFY_SMS_TRANSPORT_MISSING: 'an SMS was sent with no SmsTransport installed',
  X_NOTIFY_SMS_NUMBER_INVALID: 'an SMS number is not E.164',
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
  // "Not yet": the holder finishes or its window lapses, and the refusal names how long that is.
  // Waited out with the attempt uncounted and `maxDelay` no cap (`rateLimitDeferralMs`, jobs).
  X_NOTIFY_DELIVERY_HELD: 'retry-after',
  // Native push (`push-errors.ts`). A refusal the provider gives again — a bad credential, a wrong
  // topic, a payload over its limit — and a data push carrying more than ids: no attempt fixes
  // either. `X_NOTIFY_PUSH_DEVICE_GONE` is absent: `nativePush()` catches it, deletes the row, and
  // it never leaves a send.
  X_NOTIFY_PUSH_PROVIDER_REFUSED: 'terminal',
  X_NOTIFY_PUSH_MESSAGE_INVALID: 'terminal',
  // SMS (`sms-errors.ts`). A transport is installed at boot or it is not, and a stored number is
  // the same number on attempt 2: neither is the moment.
  X_NOTIFY_SMS_TRANSPORT_MISSING: 'terminal',
  X_NOTIFY_SMS_NUMBER_INVALID: 'terminal',
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
      fix: `give the second channel its own name on notifier("${input.notifier}") — deliveryChannel('${input.channel}-digest', …) — or merge the two deliver entries`,
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
 * (`memoryDeliveryLedger`), the way every other driver seam in this framework does. An inbox
 * and a digest window have no such default — there is nowhere to put the row — so they refuse.
 */
export class NotifyStoreMissingError extends UltimateError {
  constructor(input: { notifier: string; store: 'inbox' | 'digest' | 'ledger' }) {
    super({
      code: 'X_NOTIFY_STORE_MISSING',
      cause: STORE_MISSING_CAUSE[input.store](input.notifier),
      fix: STORE_MISSING_FIX[input.store],
      meta: { notifier: input.notifier, store: input.store },
    });
  }
}

const STORE_MISSING_CAUSE = {
  inbox: (notifier: string) =>
    `notifier "${notifier}" delivers through a channel that writes the in-app inbox and no inbox store is installed, so the rows have nowhere to go`,
  digest: (notifier: string) =>
    `notifier "${notifier}" delivers through a digest window and no digest store is installed, so the rows have nowhere to go`,
  // The memory ledger is one process's heap: behind replicas or across a restart a replay sends twice.
  ledger: (notifier: string) =>
    `notifier "${notifier}" claimed a delivery outside development and no delivery ledger is installed; a memory ledger is one process's heap, so a replayed attempt on another replica or after a restart would send twice`,
} as const;

const STORE_MISSING_FIX = {
  inbox:
    'memoryInboxStore()   # notifyStores: { inbox } in apps/<app>/runtime.ts — postgresInboxStore({ executor }) to share it across replicas',
  digest:
    'memoryDigestStore()   # notifyStores: { digest } in apps/<app>/runtime.ts — postgresDigestStore({ executor }) to share it across replicas',
  ledger:
    'notifyStores: { ledger: postgresDeliveryLedger({ executor: dbExecutor() }) }   # apps/<app>/runtime.ts — the x_notify_deliveries table the boot already applies',
} as const;

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
      fix: `drop digest from the "${input.channel}" entry on notifier("${input.notifier}") and give it a wait instead, or deliver it through deliveryChannel('${input.channel}', …) one recipient at a time`,
      meta: { notifier: input.notifier, channel: input.channel },
    });
  }
}

/**
 * A live attempt holds this delivery's claim. Never read as `sent`: that checkpoints the step, and a
 * holder that then dies is a notification no retry is left to send. `retryAfterSeconds` is the one
 * spelling a job's retry waits out, so the next attempt lands past the holder's window.
 */
export class NotifyDeliveryHeldError extends UltimateError {
  constructor(input: { notifier: string; channel: string; retryAfterMs: number }) {
    super({
      code: 'X_NOTIFY_DELIVERY_HELD',
      cause: `another attempt holds the "${input.channel}" delivery of notifier "${input.notifier}", so this one neither sent it nor counted it as sent; the claim can be reclaimed in ${String(input.retryAfterMs)} ms`,
      fix: 'x jobs list --json   # the run retries on its own once the claim can be reclaimed; to shorten that, set reclaimAfterMs on postgresDeliveryLedger()',
      meta: {
        notifier: input.notifier,
        channel: input.channel,
        // One past the window: a retry landing exactly on its edge is still refused.
        retryAfterSeconds: Math.ceil(input.retryAfterMs / 1_000) + 1,
      },
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
  constructor(input: {
    notifier: string;
    channel: string;
    recipients: number;
    cause: unknown;
    /** The channel's own `terminal`, carried over: absent, the code's `retryable` stands. */
    retry?: ErrorRetry | undefined;
  }) {
    super({
      code: 'X_NOTIFY_DELIVERY_FAILED',
      retry: input.retry,
      cause: `channel "${input.channel}" of notifier "${input.notifier}" failed for ${String(input.recipients)} recipient(s): ${renderThrowable(input.cause)}`,
      // `x jobs list` first, and never `x jobs show` handed a notifier NAME: that command takes a job id
      // positional and resolves it through `inspectJob`, which answers `X_JOB_UNKNOWN` for
      // anything else — so a notifier NAME made the one command this refusal printed fail every
      // time it was run. A `fix:` that fails is worse than none, because the reader spends their
      // trust on it before finding out. The two-step shape is what `wiki/Error-Codes.md` already
      // documents for this code.
      fix: `x jobs list --json   # find the run, then: x jobs show <id> --json — the failing step is deliver:${input.channel}`,
      meta: { notifier: input.notifier, channel: input.channel },
    });
  }
}
