# @ultimat3/mail ✉️

Transactional email as data. One template renders **both** an HTML part and a plain-text part,
every string is an i18n key, every colour is a design token, and delivery is a job.

```ts
import { defineMail, send, blocks } from '@ultimat3/mail';
import { t } from '@ultimat3/schema';

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
| Sending is a job | `retry: { attempts: 5, backoff: 'exponential' }`, idempotency key derived from `(mailId, recipients, hash(rendered))` |

## Drivers

`setMailDriver(driver)` once at boot. Asking for one that was never set is
`X_MAIL_DRIVER_UNAVAILABLE`.

| Driver | Use | Behaviour |
|---|---|---|
| `createMemoryDriver()` | dev, tests | retains messages; `outbox()` / `lastTo()` feed the `/_x` mail panel |
| `createLogDriver()` | workers without credentials | one structured line per message through core's `logger`; bodies never logged |
| `createSmtpDriver({ url, from })` | prod | real ESMTP over `Bun.connect`: STARTTLS, `AUTH PLAIN`/`LOGIN`, quoted-printable MIME |
| `createResendDriver({ apiKey, from })` | prod | one `POST /emails`, `Idempotency-Key` on every request |

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
| The reported `id` is the `Message-ID` | an SMTP `250` carries nothing a caller could correlate. It is not derived from the idempotency key, which holds the recipient list |

### Resend

`RESEND_API_KEY` and a verified sending domain. Every request carries `Idempotency-Key:
mailIdempotencyKey(message)` — a job retry after a timeout hands Resend the identical message, and
that header is what makes it one email. 408/409/425/429 and 5xx are retryable; every other non-2xx
is a configuration problem that retrying cannot fix.

## Framework mails

Registered by importing them. `FRAMEWORK_MAILS` is the list `x mail list` prints.

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
| `X_MAIL_DRIVER_UNAVAILABLE` | `setMailDriver(createMemoryDriver())` at boot |
| `X_MAIL_HEADER_INVALID` | strip CR/LF from the interpolated value before it reaches a header |
| `X_MAIL_SEND_FAILED` | the `cause` names the stage, the provider's status and whether a retry can help |

## Commands

```bash
bun test packages/mail
bun run --filter @ultimat3/mail typecheck
```
