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

`notifyStores: { ledger, inbox, digest, preferences }` in `export const runtime = { … }` (`apps/<app>/runtime.ts`), installed once by the boot, whole-object replacement (a test: `installNotifyStores` from `@ultimat3/notify/adapter`):

| Store | Default | Postgres |
|---|---|---|
| `ledger` — the delivery claim | in-memory (one process is genuinely deduped) | `postgresDeliveryLedger({ executor, windowMs })` — `windowMs` never shorter than your idempotency window |
| `preferences` — the gate | allow all | yours: **the gate ships, what it reads never does** — your taxonomy, your quiet hours. One method, `allowsMany({ recipients, notifier, channel, event, ctx })`, asked once per chunk of at most `NOTIFY_CHUNK_SIZE` (500) recipients per channel: answer the ids that may be reached. An omitted id is suppressed on that channel only |
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
- A replay does not send twice: the step checkpoint per channel and chunk of 500 recipients
  (`deliver:<channel>:chunk-<n>`), and the ledger's atomic claim on `(notifier, key, channel,
  recipient)` taken before each send — a chunk that failed part-way re-sends nobody it reached.
  10k recipients on two channels is 40 preference reads and 40 delivery steps. A digest's append
  and drain stay one step per recipient; its send is one step per chunk.
- Two attempts at once: one sends. The other raises `X_NOTIFY_DELIVERY_HELD` and retries past the
  holder's `reclaimAfterMs` (5 minutes by default), so a crashed attempt's recipient is still sent to
  and a late `settle` moves nothing.
- Entries fire in `wait` order; `if` / `unless` run **after** the wait, on the attempt that delivers.

Codes: `X_NOTIFY_CHANNELS_EMPTY`, `X_NOTIFY_CHANNEL_DUPLICATE`, `X_NOTIFY_DIGEST_UNSUPPORTED`,
`X_NOTIFY_FANOUT_TOO_WIDE` (default cap 500 recipients), `X_NOTIFY_STORE_MISSING`,
`X_NOTIFY_DELIVERY_FAILED`, and native push's `X_NOTIFY_PUSH_DEVICE_GONE`,
`X_NOTIFY_PUSH_PROVIDER_REFUSED`, `X_NOTIFY_PUSH_MESSAGE_INVALID` — [Error codes](Error-Codes).

## SMS

Rule: an SMS is a channel over the `smsTransport` port; no provider ships (axiom 8). `As of 2026-11-09`.

```ts
import { smsChannel } from '@ultimat3/notify';

export const loginCodeSms = smsChannel<{ code: string }>({
  message: ({ event }) => ({ key: 'sms.login_code', params: { code: event.params.code } }),
});
```

| Fact | Detail |
|---|---|
| the port | `smsTransport` in `apps/<app>/runtime.ts` — `SmsTransport` on `@ultimat3/notify/adapter`: `send({ to, body, idempotencyKey, signal })` → `{ transport, id, to, idempotencyKey }` |
| default | memory in development and test; elsewhere `X_NOTIFY_SMS_TRANSPORT_MISSING` (terminal) |
| prove yours | `behavesLike(smsTransportConformance, () => yours)`; a transport calls `assertSmsNumber(to)` first, and the suite checks it does |
| the body | the catalog key, rendered in `recipient.locale`, else the app's fallback |
| the number | `numberOf(recipient)`, default `recipient.to`, E.164. Not E.164 → `X_NOTIFY_SMS_NUMBER_INVALID` (terminal; the number is never in the cause). None → skipped, logged `notify.address_missing` |
| retries | `smsIdempotencyKey(notifier, key, channel, recipient)` is the same on every attempt |

## Push

`pushChannel` delivers one notification to **every device the recipient subscribed**, each in the
locale that browser subscribed with. `As of 26.1.0`. The transport is `@ultimat3/pwa`'s `webPush()`:
RFC 8291 encryption and an RFC 8292 (VAPID, ES256) token, on WebCrypto — no dependency.

```ts
import type { Recipient } from '@ultimat3/notify';
import { notifier, pushChannel, t } from '@ultimat3/notify';
import { webPush } from '@ultimat3/pwa';

// The app's own read: who follows a post. A notifier never touches the database itself.
declare const posts: {
  subscribers(postId: string, signal: AbortSignal): Promise<readonly Recipient[]>;
};

export const commentPushed = notifier({
  name: 'post.commented.push',
  input: t.object({ postId: t.uuid, commenter: t.string }),
  tenant: 'none',
  key: (params) => `comment-push:${params.postId}`,
  // The audience — every device of each of them is reached. Omitted, the audience is empty and
  // nothing is sent unless every enqueue names its own `recipients`.
  recipients: ({ input, ctx }) => posts.subscribers(input.postId, ctx.signal),
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
| 400 / 413 | `X_PWA_PUSH_REJECTED` — logged and counted, never retried |
| 401 / 403 | `X_PWA_PUSH_REJECTED`, and the subscription is deleted: it was made with a VAPID key this server no longer signs with. `subscribeToPush` replaces such a browser's subscription the next time it asks |

A retry re-sends to the devices that already got it; the `tag` makes that a replacement on the device
rather than a second notification. `renotify` without a `tag` is dropped with a warning — the spec
makes that pair show nothing at all.


## Native push — iOS and Android

`nativePush({ devices, apns, fcm })` is the pusher for native apps, `As of 2026-11-06`: APNs over
HTTP/2 with token auth (an ES256 JWT over the team's `.p8` key) and FCM HTTP v1 (a service-account
assertion exchanged for an OAuth token) — WebCrypto and core's `outbound()` with a deadline, no SDK.
Both credentials are cached and re-minted before they expire.

```ts
import {
  memoryPushDeviceStore,
  nativePush,
  notifier,
  pushChannel,
  pushRegister,
  pushUnregister,
  t,
} from '@ultimat3/notify';

// Production: `postgresPushDeviceStore({ executor: dbExecutor() })` — `x_push_devices`, a
// framework table the boot applies. ONE store, handed to the actions and the pusher alike.
const devices = memoryPushDeviceStore();

export const registerDevice = pushRegister({
  permission: 'push:subscribe',
  platforms: ['ios', 'android'],
  devices,
});
export const unregisterDevice = pushUnregister({
  permission: 'push:subscribe',
  platforms: ['ios', 'android'],
  devices,
});

const phones = nativePush({
  devices,
  apns: { teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'com.example.app' },
  fcm: { projectId: 'example-app', clientEmail: 'push@example-app.iam.gserviceaccount.com' },
});

export const approvalRequested = notifier({
  name: 'approval.requested',
  input: t.object({ approvalId: t.uuid }),
  tenant: 'none',
  key: (params) => `approval:${params.approvalId}`,
  deliver: [
    {
      // Data-only: the id and nothing else. Nothing reaches a lock screen or the provider.
      channel: pushChannel<{ approvalId: string }>({
        pusher: phones,
        data: ({ event }) => ({ approvalId: event.params.approvalId }),
      }),
    },
  ],
});
```

| Piece | Where |
|---|---|
| private keys | `x secrets set ULTIMATE_APNS_PRIVATE_KEY` (the `.p8`) · `x secrets set ULTIMATE_FCM_PRIVATE_KEY` (the service account's `private_key`). Never an option; read when a token is minted, boxed in a `Secret`, never logged. Missing: `X_ENV_MISSING`; unreadable: `X_CONFIG_INVALID` |
| devices | `x_push_devices`, keyed `(platform, token)` — a phone a second person signs in on is theirs now |
| register | `registerDevice` on every launch; `previousToken` when the OS rotated it. `unregisterDevice` on sign-out. Stored against `ctx.actor.id`; an agent never registers |
| data-only | `pushChannel({ pusher, data })` — APNs `background`, priority 5, `content-available: 1`; FCM with no `notification`. ≤ 8 string keys, ≤ 256 characters, no reserved key: else `X_NOTIFY_PUSH_MESSAGE_INVALID`. `webPush()` cannot take it — a type error |
| visible | `pushChannel({ pusher, message })`, the same `NotifyPushMessage` as the web: rendered per device locale |

| Provider answer | Outcome |
|---|---|
| 2xx | delivered |
| APNs 410 · FCM `UNREGISTERED` | `X_NOTIFY_PUSH_DEVICE_GONE` — the device row is deleted, the delivery settles |
| other 4xx | `X_NOTIFY_PUSH_PROVIDER_REFUSED` — logged, next device tried; fails the delivery when no device took it. 401/403 also drops the cached credential |
| 429 · 5xx · timeout | rethrown after every other device was tried: `X_NOTIFY_DELIVERY_FAILED`, the job retries |

A bare FCM 404 is never "gone" (a wrong `projectId` answers it too), nor is APNs `BadDeviceToken`
(a sandbox token sent to production): reading either as dead would delete every device.
