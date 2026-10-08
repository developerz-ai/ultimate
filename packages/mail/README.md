# @ultimat3/mail ✉️

Transactional email as data. One template renders **both** an HTML part and a plain-text part,
every string is an i18n key, every colour is a design token, and delivery is a job.

```ts
import { defineMail, send, blocks, t } from '@ultimat3/mail';

export const receiptMail = defineMail({
  id: 'receipt',
  subject: 'mail.receipt.subject',            // an i18n key, never a literal
  input: t.object({ name: t.string, url: t.url }),
  template: ({ data }) => [
    blocks.heading('mail.receipt.heading', { name: data.name }),
    blocks.paragraph('mail.receipt.body'),
    blocks.button('mail.receipt.cta', data.url),
  ],
});

await send(receiptMail, { name: user.name, url }, { to: user.email, locale: ctx.locale });
```

`send` validates `data` through the mail's schema, renders, then enqueues `mail.send` through the
jobs facade — inside a transaction the job is STAGED on it, so a handler that rolls back after
sending mails nobody. It delivers inline only when `{ sync: true }` is passed or no job driver is
configured.

### The outbound transform

`setMailTransform(fn)` installs one app-level hook, run once per `send()` after render and before
the idempotency key is minted — so the key, the queue row and every retry carry its bytes, and a
job retry never re-runs it. It rewrites `{ subject, html, text }` (never recipients or headers) and
receives `{ mailName, to, idempotencyKey, locale }`, where `idempotencyKey` is the UNtransformed
key: key a tracking row on it and a re-called `send()` gets the same pixel id and dedupes. A throw
or a malformed result is `X_MAIL_TRANSFORM_FAILED` and nothing is sent. `setMailTransform(undefined)`
removes it; with none installed a send is byte-identical to before.

```ts
import { type MailRendered, type MailTransformMeta, setMailTransform } from '@ultimat3/mail';

declare const TRACKED: ReadonlySet<string>;
declare function addPixelAndWrapLinks(
  rendered: MailRendered,
  meta: MailTransformMeta,
): Promise<MailRendered>;

setMailTransform(async (rendered, meta) =>
  TRACKED.has(meta.mailName) ? await addPixelAndWrapLinks(rendered, meta) : rendered,
);
```

## Rules

| Rule | Why |
|---|---|
| `locale` is required by the **type** | a mail is read hours later; there is no ambient request locale to fall back to. `X_MAIL_LOCALE_MISSING` is the backstop for JS callers |
| Text part is mandatory | HTML-only mail scores as spam and is unreadable to screen readers. Empty text ⇒ `X_MAIL_TEXT_MISSING` |
| Text is derived from blocks | never scraped out of the HTML, so the two parts cannot drift |
| Every string is a key | `mail.<id>.<slot>`; English lives in `src/catalog.ts` and app catalogs override it |
| Every colour is a token | `MAIL_TOKENS` in `layout.ts` holds light + dark hexes; templates never see a hex |
| Every date takes an IANA zone | `options.tz`, else `ctx.tz`, else `UTC` |
| No CR/LF in a header-bound field | checked in `renderMessage` and again in `sendMailJob`, so every driver refuses the same message (`X_MAIL_HEADER_INVALID`). `mime.ts` keeps its own gate for the headers the SMTP transport mints itself |
| One recipient rule on both paths | `to`, `cc`, `bcc` and `replyTo` are checked in `renderMessage` by the rule the SMTP envelope applies (`addressRefusal`), and the queue schema asks the same — so a display-form `Jane Doe <jane@x.test>` is accepted everywhere, and a control character or a non-ASCII mailbox is `X_MAIL_ADDRESS_INVALID` at the `send()` call site on every driver, never `queued: true` and then a worker's parse failure. `unsubscribeUrl` is `t.url` on both paths for the same reason |
| Address headers carry 7-bit phrases | `From`, `To`, `Cc` and `Reply-To` encode a non-ASCII display name as an RFC 2047 word and quote an ASCII one holding a special (`Doe, Jane` → `"Doe, Jane"`), so the comma cannot split the list. `List-Unsubscribe` carries the url as the WHATWG serialiser writes it — punycode host, percent-encoded path and query |
| `unsubscribeUrl` is one-click, and one-click is the supported path | it emits `List-Unsubscribe: <url>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and the footer links the SAME url. Make that url one page that answers both: `GET` renders a confirm button and never unsubscribes (scanners prefetch), and `POST` — the mail client's one-click, or the button's own form — runs the action: `defineRoute({ render: 'ssr', …, post: 'unsubscribe' })` (`@ultimat3/render`) binds it, with the url's query (`?t=<token>`) merged into the input. `unsubscribeOneClick: false` drops the `-Post` line for a url that still cannot take a POST; it is the fallback, not the path |
| Sending is a job | `retry: { attempts: 5, backoff: 'exponential' }`, idempotency key `mail:<mailId>:<hash(recipients + rendered)>` — 128 bits, ASCII, under Resend's 256-character limit at any recipient count — or `(mailId, your key)` when you pass one (digested if it is not a short ASCII token) — a caller's key is scoped to its mail so two templates cannot dedupe each other away |

## Drivers

`setMailDriver(driver)` once at boot. Asking for one that was never set is
`X_MAIL_DRIVER_UNAVAILABLE`.

| Driver | Use | Behaviour |
|---|---|---|
| `memoryMailDriver({ clock? })` | dev, tests | retains messages; `outbox()` / `lastTo()` feed the `/_x` mail panel, ordered by `SentMail.at` — pass a `frozenClock()` to choose it |
| `logMailDriver()` | workers without credentials | one structured line per message through core's `logger`; bodies never logged |
| `unconfiguredMailDriver(env)` | a deploy that configured no transport | refuses every send with `X_MAIL_CREDENTIAL_MISSING`; delivers nothing and claims nothing |
| `smtpMailDriver({ url, from })` | prod | real ESMTP over `Bun.connect`: STARTTLS, `AUTH PLAIN`/`LOGIN`, quoted-printable MIME |
| `resendMailDriver({ apiKey, from })` | prod | one `POST /emails`, `Idempotency-Key` on every request |
| `sesMailDriver({ region, credentials, from })` | prod | one SES v2 `SendEmail` with the raw MIME, SigV4-signed, no SDK |

### Which one a boot installs

`selectMailDriver(env)` is the one answer, and `x dev` and `runRole` both call it. Nothing about
the app changes between environments; the credential does.

| env | driver |
|---|---|
| *(nothing set)*, `development` / `test` | `memoryMailDriver()` — caught, never sent |
| *(nothing set)*, `staging` / `production` | `unconfiguredMailDriver(...)` — every send is `X_MAIL_CREDENTIAL_MISSING` |
| `SMTP_URL` + `MAIL_FROM` | `smtpMailDriver(...)`, `MAIL_POOL_SIZE` optional |
| `RESEND_API_KEY` + `MAIL_FROM` | `resendMailDriver(...)` |
| `SES_REGION` + `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY` + `MAIL_FROM` | `sesMailDriver(...)`; `SES_SESSION_TOKEN`, `SES_ENDPOINT`, `SES_CONFIGURATION_SET` optional |

**No credential outside development is a refusal, not the embedded default.** The memory driver
there answered `accepted` for mail that never left the process — password resets, receipts and
invitations all reported as sent, none delivered, no error anywhere. The refusal lands on the
**send**, not on the boot, so an app that sends no mail still deploys. Which environment this is
comes from core's `isLocal()` (`ULTIMATE_ENV`, else `NODE_ENV`, else `development`) — mail does not
own a second reading of it.

Both credentials at once is `X_CONFIG_INVALID` rather than a winner picked for you, and a
transport with no `MAIL_FROM` is refused at boot instead of on the first send. A host that is not
`x dev` calls `selectMailDriver` itself, or constructs a driver directly — `setMailDriver` is the
only seam either way.

### SMTP

`smtps://user:pass@host:465` is implicit TLS; `smtp://host:587` starts in the clear and upgrades
with STARTTLS. Credentials are percent-decoded, so a password with `@` or `/` works.

| Rule | Why |
|---|---|
| A server offering no STARTTLS is refused | the message *and* the password would cross in the clear. `allowInsecure: true` is the explicit opt-out |
| Capabilities are re-read after STARTTLS | most servers only advertise `AUTH` once encrypted, and a cleartext EHLO can be stripped in flight |
| Any rejected recipient fails the send | delivering to three of four addresses and reporting success is the one outcome a caller cannot detect |
| `poolSize` (default 4) caps concurrent connections | a burst of sends queues instead of opening one socket each |
| `Bcc` never reaches a header | it travels in `RCPT TO` only |
| Every envelope address is gated for CR/LF | `MAIL FROM`/`RCPT TO` are built by interpolation, and `bcc` is the one address no header check ever sees. Refused (`X_MAIL_ADDRESS_INVALID`), never stripped — a rewritten address delivers somewhere else |
| The reported `id` is the `Message-ID` | an SMTP `250` carries nothing a caller could correlate |
| The `Message-ID` is stable per message | SMTP has no idempotency protocol, so it is the one identifier a receiving mailbox can collapse a retry on. A fresh token per attempt made a timeout past `DATA` a second email. It is a one-way **digest** of `mailIdempotencyKey`, never the key: the key holds the recipient list, and this header is visible to all of them |

### Resend

`RESEND_API_KEY` and a verified sending domain. Every request carries `Idempotency-Key:
mailIdempotencyKey(message)` — a job retry after a timeout hands Resend the identical message, and
that header is what makes it one email. 408/409/425/429 and 5xx are retryable (`isRetryableStatus`, `@ultimat3/core`); every other non-2xx
is a configuration problem that retrying cannot fix.

### SES

`POST https://email.<region>.amazonaws.com/v2/email/outbound-emails` with `Content.Raw` — the
MIME `mime.ts` builds — and the envelope in `Destination` (`Bcc` included, never a header).

| SES says | `error.retry` |
|---|---|
| `TooManyRequestsException`, `ThrottlingException`, `LimitExceededException` | `retryable` |
| `MessageRejected`, `SendingPausedException`, `AccountSuspendedException`, `MailFromDomainNotVerifiedException`, any auth failure, `NotFoundException` | `terminal` |
| anything else | core's `isRetryableStatus(status)` |

All `X_MAIL_SEND_FAILED`, each with its own `aws sesv2 …` fix. SES has no idempotency header: a
retry after a timeout SES had already accepted is a second email, as over SMTP.

### `retainMime`

```ts
import { sesMailDriver } from '@ultimat3/mail';

declare const env: Record<string, string>;
declare function saveAuditRow(row: unknown): Promise<void>;

export const driver = sesMailDriver({
  region: 'eu-west-1',
  credentials: { accessKeyId: env['SES_ACCESS_KEY_ID'] ?? '', secretAccessKey: env['SES_SECRET_ACCESS_KEY'] ?? '' },
  from: 'Postly <no-reply@postly.test>',
  retainMime: { maxBytes: 262_144, onRetained: (entry) => saveAuditRow(entry) },
});
```

SMTP and SES (the transports that build the MIME). The exact bytes handed to the provider, on
`SendResult.mime` and to `onRetained` — the durable half, because a queued send's result is not
persisted. Cap: default 256 KiB, at most 10 MiB; **over it only `{ kind: 'digest-only', sha256,
byteLength }` is kept, never a truncated message.** A throwing `onRetained` is logged
(`mail.retain_mime.failed`) and does not fail the send. `selectMailDriver(env, { retainMime })`
refuses it for Resend, which builds the MIME on its own side, and judges the cap BEFORE it picks a
transport — a cap over the ceiling is `X_CONFIG_INVALID` on every branch, memory included.
`retainMimeKey` names where the option was written in that refusal (`mail.retainMime` from an
`app.config.ts`); default `retainMime`.

### Delivery events

Imported from **`@ultimat3/mail/events`**, never the barrel: only a webhook route needs them, and every serving role loads `@ultimat3/mail` to send. One receiver per provider, its `receive(request)` mounted as a plain HTTP route through the `routes` runtime override (`apps/<app>/runtime.ts`) — not an `api/**/route.ts`, which is refused at registration (`X_ROUTE_FILE_INVALID`); each verifies, then normalises to
`DeliveryEvent` — `delivered` · `bounced` (`bounce: 'hard' | 'soft'`) · `complained` · `delayed`,
with `messageId` (= the sending driver's `SendResult.id`), `recipient`, `at`, `eventId` and `raw`.
One event per recipient; `(eventId, recipient)` is the dedupe key.

```ts
import { resendEventReceiver, sesEventReceiver } from '@ultimat3/mail/events';

declare const env: Record<string, string>;

export const ses = sesEventReceiver({ topicArns: [env['SES_EVENTS_TOPIC_ARN'] ?? ''] });
export const resend = resendEventReceiver({ secret: env['RESEND_WEBHOOK_SECRET'] ?? '' });
// const outcome = await ses.receive(request);  // { type: 'events' | 'ignored' | 'subscription', … }
```

| Receiver | Proves |
|---|---|
| `sesEventReceiver` | SNS: the topic is in `topicArns`, the cert URL is `https://sns.<topic region>.amazonaws.com/…pem`, `SignatureVersion` 1 (RSA-SHA1) or 2 (RSA-SHA256) over AWS's canonical string, `Timestamp` within `toleranceMs` (1 h). A `SubscriptionConfirmation` returns its `confirmUrl`; it is fetched only with `confirmSubscriptions: true` |
| `resendEventReceiver` | Svix: HMAC-SHA256 over `svix-id.svix-timestamp.body` under the `whsec_` secret, constant-time, any `v1,` entry, within `toleranceMs` (5 min) |

## Framework mails

Registered by importing them — the import IS the registration. `FRAMEWORK_MAILS` is the list, and
`registeredMails()` / `registeredMailIds()` answer for an app's own mails as well. There is no
`x mail` command; a host that wants to list or preview a mail calls those and `renderMessage()`.

| id | Input |
|---|---|
| `welcome` | `{ name, appName, url }` |
| `verify-email` | `{ name, url, expiresMinutes }` |
| `reset-password` | `{ name, url, expiresMinutes }` |
| `invite` | `{ inviterName, orgName, url, expiresHours }` |
| `mfa-enrolled` | `{ name, method, at }` |
| `security-alert` | `{ name, event, ip, at }` |

Translating them = shipping `mail.*` keys in an app catalog. Never edit a template.

## Errors

| Code | Fix |
|---|---|
| `X_MAIL_LOCALE_MISSING` | `send(mail, data, { to, locale: ctx.locale })` |
| `X_MAIL_TEMPLATE_UNKNOWN` | export a `defineMail({ id })` and import it (also raised for an unregistered layout) |
| `X_MAIL_DUPLICATE` | rename one of two `defineMail({ id })` declarations |
| `X_MAIL_TEXT_MISSING` | add a text-bearing block to the template |
| `X_MAIL_DRIVER_UNAVAILABLE` | `setMailDriver(memoryMailDriver())` at boot — a wiring bug |
| `X_MAIL_CREDENTIAL_MISSING` | set `SMTP_URL` (or `RESEND_API_KEY`) and `MAIL_FROM` in the deployment — an operations one |
| `X_MAIL_HEADER_INVALID` | strip CR/LF from the interpolated value before it reaches a header |
| `X_MAIL_ADDRESS_INVALID` | a recipient may hold no control character, its mailbox no `<`/`>` and no non-ASCII byte (`meta.reason`); `Jane Doe <jane@x.test>` is fine |
| `X_MAIL_TRANSFORM_FAILED` | the `setMailTransform` hook threw or returned no `{ subject, html, text }` — fix the hook; the mail was not sent |
| `X_MAIL_EVENT_UNVERIFIED` | a delivery notification failed its signature check — `meta.reason` names which (`unsigned`, `signature`, `stale`, `topic`, `certificate-url`, `signature-version`); answer 401 |
| `X_MAIL_EVENT_INVALID` | authentic or not, the body is not the provider's notification shape (`meta.problem`); answer 400 |
| `X_MAIL_EVENT_PROVIDER_UNREACHABLE` | the SNS certificate or confirm URL did not answer; answer 503 so SNS redelivers |
| `X_MAIL_SEND_FAILED` | the `cause` names the stage, the provider's status and whether a retry can help — and so does `error.retry`, which is what `sendMailJob` acts on: `terminal` dead-letters a 550 or a rejected credential at attempt 1 instead of sending it four more times |

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `MailError` | any `MailErrorCode` — `MAIL_ERROR_CODES` | `src/errors.ts` (the `X_MAIL_EVENT_*` factories export from `@ultimat3/mail/events`) |

## Commands

```bash
bun test packages/mail
bun run --filter @ultimat3/mail typecheck
```
