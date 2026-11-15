// Single responsibility: the two refusals an inbound message earns once its signature verified —
// bytes that are not MIME this parser reads, and bytes past a declared bound. Closed vocabularies,
// so no cause ever echoes a sender's bytes; both are terminal: a retry reads the same message.

import { MailError } from './errors';

/** What could not be read. Every value is a fact about the message, never a quote from it. */
export type InboundMalformation =
  | 'empty'
  | 'header'
  | 'boundary-missing'
  | 'boundary-invalid'
  | 'boundary-absent'
  | 'boundary-unclosed'
  | 'transfer-encoding'
  | 'base64'
  | 'content-missing'
  | 'raw-unavailable'
  | 'row';

const MALFORMED: Readonly<Record<InboundMalformation, string>> = {
  empty: 'is empty or opens with no header section',
  header: 'has a header line with no field name and colon (RFC 5322 §2.2)',
  'boundary-missing': 'declares a multipart part with no boundary parameter (RFC 2046 §5.1.1)',
  'boundary-invalid': 'declares a multipart boundary longer than 70 characters or empty',
  'boundary-absent': 'declares a multipart part whose body never names its boundary',
  'boundary-unclosed': 'declares a multipart part whose closing --boundary-- never arrives',
  'transfer-encoding': 'declares a Content-Transfer-Encoding outside 7bit/8bit/binary/base64/QP',
  base64: 'declares base64 for a part whose body is not base64',
  'content-missing': 'is an SES notification that carries no message content',
  'raw-unavailable': 'is a Resend email whose raw MIME the API does not offer',
  row: 'was queued in a row this receiver did not write — another producer enqueued its job name',
};

const MALFORMED_FIX: ReadonlyMap<InboundMalformation, string> = new Map([
  [
    'content-missing',
    'aws ses describe-active-receipt-rule-set — the rule needs an SNS action with Encoding BASE64; SES omits content over 150 KB, which this receiver cannot read',
  ],
  [
    'raw-unavailable',
    "curl -sS https://api.resend.com/emails/receiving/<email id> -H 'Authorization: Bearer <RESEND_API_KEY>' — raw is null until Resend stores the message; the job retries",
  ],
]);

export const inboundMalformed = (problem: InboundMalformation): MailError =>
  new MailError({
    code: 'X_MAIL_INBOUND_MALFORMED',
    cause: `an inbound message ${MALFORMED[problem]}`,
    fix:
      MALFORMED_FIX.get(problem) ??
      'x jobs list --state dead --json — the row is the record: the sending client wrote MIME no retry can repair, so answer the sender out of band',
    meta: { problem },
    // A raw file Resend has not stored YET is the one malformation time repairs.
    ...(problem === 'raw-unavailable' ? { retry: 'retryable' as const } : {}),
  });

/** Which bound an inbound message crossed. Each is an `InboundLimits` field. */
export type InboundLimit =
  | 'maxBytes'
  | 'maxParts'
  | 'maxDepth'
  | 'maxAttachments'
  | 'maxHeaderBytes';

export const inboundTooLarge = (limit: InboundLimit, max: number): MailError =>
  new MailError({
    code: 'X_MAIL_INBOUND_TOO_LARGE',
    cause: `an inbound message crosses its ${limit} bound of ${max} — refused whole, never truncated`,
    fix: `inboundMail({ limits: { ${limit}: ${max * 2} } }) — only if mail this large is mail you expect; a sender past the bound is refused, not read`,
    meta: { limit, max },
  });
