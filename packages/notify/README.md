# @ultimat3/notify

Notifications as one declaration: channel fan-out, a preference gate, a digest window, a delivery
ledger and an in-app inbox.

`notifier()` is a **job factory** — it returns a `JobHandle`, so a notification inherits retry, the
dead-letter path, cancellation, `x jobs show` and its manifest row. It is not a ninth primitive.

## The declaration

```ts
import type { MailDefinition } from '@ultimat3/mail';
import { send } from '@ultimat3/mail';
import type { Recipient } from '@ultimat3/notify';
import { inAppChannel, mailChannel, notifier, t } from '@ultimat3/notify';

interface CommentPosted {
  readonly postId: string;
  readonly orgId: string;
  readonly author: string;
}

// The app's own template, and the app's own repository — `./mail.ts` and a service its boot
// installed. Neither ships here: this package knows a mailer and an audience, not your tables.
declare const postCommented: MailDefinition<CommentPosted>;
declare const posts: {
  subscribers(postId: string, signal: AbortSignal): Promise<readonly Recipient[]>;
};

export const commentPosted = notifier({
  name: 'post.commented',
  input: t.object({ postId: t.uuid, orgId: t.uuid, author: t.string }),
  // Required, exactly as on job(): the org this run acts under.
  tenant: (params) => params.orgId,
  // Required, exactly as job().idempotencyKey is — and it is the SAME value: the queue's dedupe
  // key and the delivery ledger's event column ask one question.
  key: (params) => `comment:${params.postId}`,
  // Resolved on the worker, inside a durable step. Omit it and every enqueue names its own.
  // `ctx.signal` is the run's cancellation — hand it to anything that can block.
  recipients: ({ input, ctx }) => posts.subscribers(input.postId, ctx.signal),
  deliver: [
    // Fires immediately: no wait.
    { channel: inAppChannel() },
    // Waits ten minutes, then re-reads the condition. A subscriber who muted the thread in
    // minute three gets nothing.
    {
      // The type argument is what types `mail.batch[n].params`: `NoInfer` on `deliver` stops the
      // channel from deciding what the params are — the schema above already did.
      channel: mailChannel<CommentPosted>({
        mailer: {
          send: async (mail) => {
            // `batch` is never empty: one event for an immediate send, the whole window for a
            // digest. Oldest first, so the newest is the last.
            for (const event of mail.batch) {
              await send(postCommented, event.params, { to: mail.to, locale: mail.locale ?? 'en' });
            }
          },
        },
      }),
      wait: '10m',
      unless: ({ event }) => event.params.author === 'system',
      // Coalesce every comment on this post for one person into one email per hour.
      digest: { window: '1h', group: (event) => event.params.postId },
    },
  ],
});
```

Enqueued like any other job:

```ts
import type { JobHandle } from '@ultimat3/jobs';
import type { NotifyPayload } from '@ultimat3/notify';

// The declaration above: `notifier()` returns a JobHandle, so this IS the job's own enqueue.
declare const commentPosted: JobHandle<
  NotifyPayload<{ postId: string; orgId: string; author: string }>
>;
declare const postId: string;
declare const orgId: string;
declare const author: string;

await commentPosted.enqueue({ params: { postId, orgId, author } });
// …or with the audience handed in, `noticed`'s `.deliver(recipients)`:
await commentPosted.enqueue({
  params: { postId, orgId, author },
  recipients: [{ id: 'u_1', to: 'ana@example.com', locale: 'en-GB', tz: 'Europe/London' }],
});
```

The payload nests `params` rather than spreading it, so an app whose notification is *about*
recipients cannot collide with the framework's own key.

## Installing the stores

One call, at boot. Whole-object replacement, never a merge.

```ts
import type { PgExecutor } from '@ultimat3/jobs';
import {
  createMemoryDigestStore,
  createPgDeliveryLedger,
  createPgInboxStore,
  setNotifyStores,
} from '@ultimat3/notify';

declare const executor: PgExecutor;   // `@ultimat3/cli`'s pgExecutorFor(client)
declare const idempotency: { readonly windowMs: number };   // the boot's own store
// The app's preference table, behind whatever taxonomy it named.
declare const prefs: {
  allows(recipient: string, notifier: string, channel: string, at: Date): boolean;
};

setNotifyStores({
  // `windowMs` is how long a settled claim is kept. NEVER SHORTER than your idempotency window —
  // a job replayed inside that window against a purged claim claims cleanly and sends twice.
  ledger: createPgDeliveryLedger({ executor, windowMs: idempotency.windowMs }),
  inbox: createPgInboxStore({ executor }),
  digest: createMemoryDigestStore(),
  preferences: {
    // The GATE ships; what it reads never does. Your taxonomy, your quiet hours.
    allows: ({ recipient, notifier: name, channel, ctx }) =>
      prefs.allows(recipient.id, name, channel, ctx.now()),
  },
});
```

| Store | Default | Why |
|---|---|---|
| `ledger` | `createMemoryDeliveryLedger()` | one process is genuinely deduped by a heap map, and no ledger at all means a replay sends twice |
| `preferences` | `allowAllPreferences()` | denying by default is a notifier that silently delivers nothing |
| `inbox` | **none** — `X_NOTIFY_STORE_MISSING` | a message written to nowhere is worse than a refusal |
| `digest` | **none** — `X_NOTIFY_STORE_MISSING` | same |

`executor` is a structural `{ query(sql, params) }` — `@ultimat3/cli`'s `pgExecutorFor(client)` over
a `DbClient` is the framework's own. `Bun.sql` does **not** satisfy it.

## Retention

Both tables grow with traffic, and the boot's hourly `x.purge` job sweeps both — but only against
the **Postgres** stores. `createPgInboxStore` carries `purgeBefore` and `createPgDeliveryLedger`
carries `purgeExpired`; the memory ones do not, and a boot that installed a memory store sweeps
nothing. The methods are on those stores' own wider types (`PgInboxStore`, `PgDeliveryLedger`), not
on `InboxStore`/`DeliveryLedger`, so an app that wrote its own implementation is unaffected.

| Table | Window | Default |
|---|---|---|
| `x_notify_deliveries` | `createPgDeliveryLedger({ windowMs })` | 24 h. A settled claim ages from its **last** attempt — `settle` moves `at` |
| `x_notify_inbox` | `notify.inboxReadRetentionMs` / `notify.inboxUnreadRetentionMs` in `app.config.ts` | **neither** — never swept |

The inbox default is deliberate and is not a missing number. An inbox row is a message a person has
not read yet, so when it disappears is your decision, not the framework's — which is why the key
lives in **your** config and why there are two of them: read notices gone in a month with unread
ones kept forever is the shape most apps want, and it is only expressible if the two windows are
separate.

```ts
// app.config.ts
notify: { inboxReadRetentionMs: 30 * 24 * 60 * 60 * 1000 }
```

A read row ages from `read_at` and an unread one from `created_at` — ageing a read row from
`created_at` would delete a notification the moment the recipient opened an old one.

## Channels

```ts
import { bulkChannel, channel } from '@ultimat3/notify';

// The app's push vendor and its Slack webhook — a channel is where an SDK belongs.
declare const pushService: {
  send(token: string, payload: unknown, init: { signal: AbortSignal }): Promise<void>;
};
declare const SLACK_URL: string;

// One call per recipient. The retry unit is one address.
export const push = channel('push', async ({ recipient, event, signal }) => {
  await pushService.send(recipient.to ?? '', event.params, { signal });
});

// ONE call for the whole audience — a Slack post, a webhook, a digest to an ops channel.
export const slack = bulkChannel('slack', async ({ recipients, event, signal }) => {
  await fetch(SLACK_URL, {
    method: 'POST',
    body: JSON.stringify({ text: `${String(recipients.length)} watchers`, event: event.key }),
    signal,
  });
});
```

`inAppChannel()` and `mailChannel({ mailer })` ship. `mailChannel` takes a **structural** `Mailer` —
one method, no dependency on `@ultimat3/mail`, which is the same tier.

## The inbox

```ts
import type { Ctx } from '@ultimat3/core';
import { requireInbox } from '@ultimat3/notify';

declare const ctx: Ctx;   // the request context; `ctx.actor` is who is reading

const store = requireInbox('post.commented');
const page = await store.list({ recipient: ctx.actor.id, limit: 50 });
const badge = await store.unreadCount(ctx.actor.id);
await store.markSeen({ recipient: ctx.actor.id, at: ctx.now() });
await store.markRead({ recipient: ctx.actor.id, ids: [page[0]?.id ?? ''], at: ctx.now() });
```

`seenAt` and `readAt` are two facts — showing the badge does not dismiss the message — and the
unread count is **derived** from `readAt is null`, never stored, so the badge and the list cannot
disagree. Every write is scoped by recipient: an id somebody else named is simply absent.

## Delivery order

`deliver` entries are sorted by `wait` ascending and the fan-out sleeps the **delta**, so a channel
with no wait fires immediately even when a later one waits an hour. `if` and `unless` are evaluated
**after** the wait, on the attempt that delivers — a condition that goes false during a ten-minute
delay sends nothing.

## At-least-once

A job body runs before its checkpoint lands. Two layers stop a double send: the step checkpoint
(`deliver:<channel>:<recipient>`), and the delivery ledger's atomic claim on
`(notifier, key, channel, coalesce(recipient, ''))` — taken before the send, settled after. A claim
that already reads `sent` answers `false`.

A bulk channel claims **one** row for the whole audience, with a null recipient: half a bulk POST is
not a state this package can represent. That null is why the key coalesces rather than naming the
column: NULLs are distinct in a plain unique index, so a bulk claim would otherwise be claimable
without bound and every replay would re-send the whole audience.

## Errors

| Code | When |
|---|---|
| `X_NOTIFY_CHANNELS_EMPTY` | `deliver: []` — refused at declaration |
| `X_NOTIFY_CHANNEL_DUPLICATE` | two deliveries name one channel; the ledger keys on it |
| `X_NOTIFY_DIGEST_UNSUPPORTED` | a digest window on a bulk channel |
| `X_NOTIFY_FANOUT_TOO_WIDE` | more recipients than `maxRecipients` (default 500) |
| `X_NOTIFY_STORE_MISSING` | an inbox or digest channel with no store installed |
| `X_NOTIFY_DELIVERY_FAILED` | a channel's `deliver` threw; the run retries on its policy |

## Boundary

Tier 4. May import tiers 0-3 — enforced by `bun run boundaries`. Its real imports are `core`,
`schema`, `time` and `jobs`, so tier 4 is its floor. See [`CLAUDE.md`](./CLAUDE.md).
