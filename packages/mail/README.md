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

`send` validates `data` through the mail's schema, renders, then enqueues `mail.send`. It
delivers inline only when `{ sync: true }` is passed or no job driver is configured.

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
| Sending is a job | `retry: { attempts: 5, backoff: 'exponential' }`, idempotency key derived from `(mailId, recipients, hash(rendered))`, or `(mailId, your key)` when you pass one — a caller's key is scoped to its mail so two templates cannot dedupe each other away |

## Drivers

`setMailDriver(driver)` once at boot. Asking for one that was never set is
`X_MAIL_DRIVER_UNAVAILABLE`.

| Driver | Use | Behaviour |
|---|---|---|
| `createMemoryDriver()` | dev, tests | retains messages; `outbox()` / `lastTo()` feed the `/_x` mail panel |
| `createLogDriver()` | workers without credentials | one structured line per message through core's `logger`; bodies never logged |
| `createUnconfiguredDriver(env)` | a deploy that configured no transport | refuses every send with `X_MAIL_CREDENTIAL_MISSING`; delivers nothing and claims nothing |
| `createSmtpDriver({ url, from })` | prod | real ESMTP over `Bun.connect`: STARTTLS, `AUTH PLAIN`/`LOGIN`, quoted-printable MIME |
| `createResendDriver({ apiKey, from })` | prod | one `POST /emails`, `Idempotency-Key` on every request |

### Which one a boot installs

`selectMailDriver(env)` is the one answer, and `x dev` and `runRole` both call it. Nothing about
the app changes between environments; the credential does.

| env | driver |
|---|---|
| *(nothing set)*, `development` / `test` | `createMemoryDriver()` — caught, never sent |
| *(nothing set)*, `staging` / `production` | `createUnconfiguredDriver(...)` — every send is `X_MAIL_CREDENTIAL_MISSING` |
| `SMTP_URL` + `MAIL_FROM` | `createSmtpDriver(...)`, `MAIL_POOL_SIZE` optional |
| `RESEND_API_KEY` + `MAIL_FROM` | `createResendDriver(...)` |

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
that header is what makes it one email. 408/409/425/429 and 5xx are retryable; every other non-2xx
is a configuration problem that retrying cannot fix.

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
| `X_MAIL_DRIVER_UNAVAILABLE` | `setMailDriver(createMemoryDriver())` at boot — a wiring bug |
| `X_MAIL_CREDENTIAL_MISSING` | set `SMTP_URL` (or `RESEND_API_KEY`) and `MAIL_FROM` in the deployment — an operations one |
| `X_MAIL_HEADER_INVALID` | strip CR/LF from the interpolated value before it reaches a header |
| `X_MAIL_ADDRESS_INVALID` | pass a bare `addr-spec` — an envelope address may hold no control character and no `<`/`>` |
| `X_MAIL_SEND_FAILED` | the `cause` names the stage, the provider's status and whether a retry can help — and so does `error.retry`, which is what `sendMailJob` acts on: `terminal` dead-letters a 550 or a rejected credential at attempt 1 instead of sending it four more times |

## Commands

```bash
bun test packages/mail
bun run --filter @ultimat3/mail typecheck
```
