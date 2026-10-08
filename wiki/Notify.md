# Notify

**One declaration, many channels**: fan-out, a preference gate, a digest window, a delivery ledger
and an in-app inbox. Package `@ultimat3/notify` (tier 4) — the full reference is
[`packages/notify/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/notify/README.md).

`notifier()` is a **job factory**: it returns a `JobHandle`, so a notification inherits retry, the
dead-letter path, cancellation, `x jobs show` and its manifest row — the same shape `backfill()`
and `llm()` take ([The eight primitives](The-Eight-Primitives)). It is not a ninth primitive.

```ts
import { inAppChannel, mailChannel, notifier, t } from '@ultimat3/notify';

export const commentPosted = notifier({
  name: 'post.commented',
  input: t.object({ postId: t.uuid, orgId: t.uuid, author: t.string }),
  tenant: (params) => params.orgId,          // required, as on job()
  key: (params) => `comment:${params.postId}`, // the queue's dedupe key AND the ledger's event key
  recipients: ({ input, ctx }) => posts.subscribers(input.postId, ctx.signal),
  deliver: [
    { channel: inAppChannel() },               // immediately
    {
      channel: mailChannel({ mailer }),
      wait: '10m',                             // then re-read the condition: a mute in minute 3 wins
      unless: ({ event }) => event.params.author === 'system',
      digest: { window: '1h', group: (event) => event.params.postId },
    },
  ],
});

await commentPosted.enqueue({ params: { postId, orgId, author } });
```

## The stores

`setNotifyStores({ ledger, inbox, digest, preferences })` once at boot, whole-object replacement:

| Store | Default | Postgres |
|---|---|---|
| `ledger` — the delivery claim | in-memory (one process is genuinely deduped) | `postgresDeliveryLedger({ executor, windowMs })` — `windowMs` never shorter than your idempotency window |
| `preferences` — the gate | allow all | yours: **the gate ships, what it reads never does** — your taxonomy, your quiet hours |
| `inbox` | none — `X_NOTIFY_STORE_MISSING` | `postgresInboxStore({ executor })` |
| `digest` | none — `X_NOTIFY_STORE_MISSING` | `postgresDigestStore({ executor })` — one window per slot across replicas; `memoryDigestStore()` for one process |

The hourly `x.purge` job sweeps the Postgres ledger, inbox and digest windows (a closed window a week old, by default) — and, in the same pass, `x_job_events`, the stored bus `step.waitForEvent` reads. The inbox is swept only when your
`app.config.ts` sets `notify.inboxReadRetentionMs` / `notify.inboxUnreadRetentionMs` — when an unread
message disappears is your decision ([Configuration](Configuration)).

## Channels, the inbox, and at-least-once

- `deliveryChannel(name, fn)` delivers per recipient; `bulkChannel(name, fn)` makes **one** call for the
  whole audience (a Slack post, a webhook) and cannot take a digest (`X_NOTIFY_DIGEST_UNSUPPORTED`).
  `inAppChannel()`, `mailChannel({ mailer })` and `pushChannel({ pusher, message })` ship; `mailer` and
  `pusher` are structural, so [Mail](Mail) and `@ultimat3/pwa` plug in without an import — [Push](#push).
- `requireInbox(name)` answers `list`, `unreadCount`, `markSeen`, `markRead`. `seenAt` and `readAt`
  are two facts, and the unread count is derived, never stored.
- A recipient id named twice in the audience is one recipient: the list is deduplicated by `id`,
  first entry kept, before any channel runs.
- A replay does not send twice: the step checkpoint per channel and recipient, and the ledger's
  atomic claim on `(notifier, key, channel, recipient)` taken before the send.
- Entries fire in `wait` order; `if` / `unless` run **after** the wait, on the attempt that delivers.

Codes: `X_NOTIFY_CHANNELS_EMPTY`, `X_NOTIFY_CHANNEL_DUPLICATE`, `X_NOTIFY_DIGEST_UNSUPPORTED`,
`X_NOTIFY_FANOUT_TOO_WIDE` (default cap 500 recipients), `X_NOTIFY_STORE_MISSING`,
`X_NOTIFY_DELIVERY_FAILED` — [Error codes](Error-Codes).

## Push

`pushChannel` delivers one notification to **every device the recipient subscribed**, each in the
locale that browser subscribed with. `As of 26.1.0`. The transport is `@ultimat3/pwa`'s `webPush()`:
RFC 8291 encryption and an RFC 8292 (VAPID, ES256) token, on WebCrypto — no dependency.

```ts
import { notifier, pushChannel, t } from '@ultimat3/notify';
import { webPush } from '@ultimat3/pwa';

export const commentPushed = notifier({
  name: 'post.commented.push',
  input: t.object({ postId: t.uuid, commenter: t.string }),
  tenant: 'none',
  key: (params) => `comment-push:${params.postId}`,
  deliver: [
    {
      channel: pushChannel<{ postId: string; commenter: string }>({
        pusher: webPush(),
        // Catalog KEYS, never text: rendered per subscription, in its own locale.
        message: ({ event }) => ({
          titleKey: 'push.comment.title',
          bodyKey: 'push.comment.body',
          params: { who: event.params.commenter },
          url: `/posts/${event.params.postId}`, // a path on this app; anything else opens the root
          tag: `post:${event.params.postId}`, // set it: a retry re-sends, a tag makes it a replacement
        }),
      }),
    },
  ],
});
```

| Piece | Where |
|---|---|
| config | `pwa: { push: true, vapid: { subject: 'mailto:ops@example.com' } }` ([Configuration](Configuration)) |
| key pair | `x vapid create` seals `ULTIMATE_VAPID_PUBLIC_KEY` + `ULTIMATE_VAPID_PRIVATE_KEY`; a local process with neither signs with a published development pair, a deployed boot refuses it (`X_PWA_VAPID_KEY_MISSING`) |
| subscriptions | `x_push_subscriptions`, a framework table the boot applies; the boot installs the store |
| subscribe / unsubscribe | `export const subscribePush = pushSubscribe({ permission: 'push:subscribe' })` and `pushUnsubscribe(…)` in an actions module — real actions, on the one authz path, stored against `ctx.actor.id`; an agent never subscribes |
| the button | `subscribeToPush({ save: client.subscribePush })` from `@ultimat3/pwa/client`, on a click: asks permission, subscribes with the key in `<meta name="x-push-key">`, saves the page's locale and the device's zone |

What each push-service answer does:

| Answer | Outcome |
|---|---|
| 201 | delivered |
| 404 / 410, or an expired subscription | the subscription is deleted; nothing is retried |
| 429 / 5xx / no connection | `X_PWA_PUSH_FAILED` — thrown after every other device was tried, so the delivery fails as `X_NOTIFY_DELIVERY_FAILED` and the notifier job retries on its own backoff |
| 400 / 401 / 403 / 413 | `X_PWA_PUSH_REJECTED` — logged and counted, never retried |

A retry re-sends to the devices that already got it; the `tag` makes that a replacement on the device
rather than a second notification. `renotify` without a `tag` is dropped with a warning — the spec
makes that pair show nothing at all.

