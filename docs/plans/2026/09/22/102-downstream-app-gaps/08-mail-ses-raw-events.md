# 08 — Mail: SES driver, exact MIME, delivery events

> Part of [`overview.md`](overview.md). Depends on: 01 (`signAwsRequest`), 05 (`defineApiRoute`, `verifyHmacSignature`/`bodyBytes`). Tier: 4.

Rules:
- The MIME a message was sent as is a value the caller can keep, byte for byte. Every driver that
  builds MIME builds it once, through `buildMimeMessage` (`packages/mail/src/mime.ts:50`).
- A delivery outcome (delivered, bounced, complained, deferred) has one shape across providers. A
  provider's webhook becomes that shape through a normaliser, never through app parsing.

## Files to change
- `packages/mail/src/driver.ts:33-46` — `SendResult.mime?: Uint8Array`, filled when `MailMessage.retainMime === true`.
  - SMTP (`driver-smtp.ts`) and SES send exactly these bytes.
  - Resend builds provider-side, so it answers `mime: undefined` and says so in the README.
  - A test asserts that SMTP's `DATA` payload equals `SendResult.mime`.
- `packages/mail/src/driver-ses.ts` (new, < 200 LOC) — `createSesDriver({ region, from, configurationSet?, credentials env names })`.
  - One `POST https://email.<region>.amazonaws.com/v2/email/outbound-emails` with `Content: { Raw: { Data: base64(mime) } }`, signed by `signAwsRequest` (slice 01).
  - Maps 4xx/5xx to `X_MAIL_SEND_FAILED` with the permanent vs retry distinction `errors.ts:50-71` already models.
  - Uses the same `Idempotency`/dedupe rule as Resend (`idempotency.ts`).
- `packages/mail/src/driver-env.ts` — `selectMailDriver(env)` picks SES when `SES_REGION` is set. Order: SMTP URL, then Resend key, then SES region, then unconfigured. README table updated.
- `packages/mail/src/delivery-event.ts` (new) — `DeliveryEvent = { messageId, recipient, kind: 'delivered' | 'bounced' | 'complained' | 'deferred' | 'rejected', at: Instant, permanent: boolean, smtp?: { status?, diagnostic?, remoteMta?, reportingMta? }, raw: string }`. `raw` holds the exact provider payload text, for evidence.
- `packages/mail/src/delivery-ses.ts` (new):
  - `parseSesNotification(text)` covers SES event publishing via SNS, including the `SubscriptionConfirmation` handshake answer and the `Notification` envelope.
  - SNS signature verification: fetch the signing cert from the `SigningCertURL`, refusing any host outside `sns.<region>.amazonaws.com`, then verify with `crypto.subtle` RSA over SNS's canonical field string.
  - `parseResendEvent(bytes, headers, secret)` uses `verifyHmacSignature` (slice 05).
  - Unknown event types raise `X_MAIL_EVENT_UNRECOGNIZED`. They are never dropped silently.
- `packages/mail/src/errors.ts` — `X_MAIL_EVENT_UNRECOGNIZED`.
- `packages/mail/README.md` — driver table row, §"Keep what you sent" (`retainMime`), §"Delivery events". The example is an `api/mail/events/route.ts` built on `defineApiRoute` that hands `DeliveryEvent` to an idempotent app action.

## Steps
1. Add `retainMime` through `buildMimeMessage`, with SMTP as the proof.
2. Add the SES driver against a recorded request fixture (sealed network, no live call in the unit suite).
3. Add the normalisers with recorded payload fixtures: SES bounce, delivery, complaint, and SNS subscription confirmation.

## Tests
- `bun test packages/mail/src/driver-ses.test.ts packages/mail/src/delivery-ses.test.ts packages/mail/src/driver-smtp.test.ts`.
- The SES body's `Raw.Data` decodes to exactly `SendResult.mime`.
- A cert URL on a foreign host is refused. A tampered `Message` fails the signature.
- The bounce fixture gives `permanent: true` and `smtp.status` / `smtp.diagnostic`, when present in the payload.
- `driver-ses.live.test.ts` (opt-in) sends to the SES mailbox simulator and asserts a `messageId`.

## Done when
- One app can send through SES, keep the exact `.eml` bytes, and turn SES and Resend notifications into `DeliveryEvent`s without parsing provider JSON itself.
- Whether SES events carry the SMTP fields an app needs is a property of the provider. The README says which fields are best-effort.
