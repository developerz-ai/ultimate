// Single responsibility: one verified queue row → the typed `InboundMessage` a handler receives —
// the provider hands over the raw MIME, the bounded parser reads it, storage takes the
// attachments. The row is re-parsed here: the queue holds JSON, and a row is not proof of shape.

import { t, validate } from '@ultimat3/schema';
import { storeAttachments } from './inbound-attachments';
import type {
  InboundAttachmentOptions,
  InboundMessage,
  InboundProvider,
  InboundRow,
} from './inbound-types';
import { type MimeLimits, parseMime } from './mime-parse';
import { parseAddressList } from './mime-parse-address';
import { inboundMalformed } from './mime-parse-errors';
import { headerOf, rawHeaderOf } from './mime-parse-headers';

const rowSchema = t.discriminatedUnion(
  'provider',
  t.object({
    provider: t.literal('ses'),
    recipients: t.array(t.string),
    content: t.string,
    encoding: t.enum(['BASE64', 'UTF8']),
    verdicts: t.record(t.string),
  }),
  t.object({ provider: t.literal('resend'), recipients: t.array(t.string), emailId: t.string }),
);

export interface ReadInboundInput {
  readonly provider: InboundProvider;
  readonly eventId: string;
  readonly orgId: string | undefined;
  readonly payload: unknown;
  readonly limits: MimeLimits;
  readonly attachments: InboundAttachmentOptions | false;
}

function dateOf(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

export async function readInbound(input: ReadInboundInput): Promise<InboundMessage> {
  const parsedRow = validate(rowSchema, input.payload);
  if (parsedRow.issues !== undefined) throw inboundMalformed('row');
  const row: InboundRow = parsedRow.value;
  const raw = await input.provider.mime(row, input.limits.maxBytes);
  const parsed = parseMime(raw, input.limits);
  const infected =
    row.provider === 'ses' &&
    row.verdicts['virus'] === 'FAIL' &&
    (input.attachments === false || input.attachments.keepOnVirusFail !== true);
  const attachments = await storeAttachments({
    attachments: parsed.attachments,
    options: input.attachments,
    eventId: input.eventId,
    orgId: input.orgId,
    withheld: infected ? 'verdict' : undefined,
  });
  const header = (name: string) => headerOf(parsed.headers, name);
  // Address lists are split on the RAW header: a decoded comma in a name is text.
  const addresses = (name: string) => parseAddressList(rawHeaderOf(parsed.headers, name));
  return {
    provider: row.provider,
    eventId: input.eventId,
    recipients: row.recipients,
    messageId: header('message-id'),
    from: addresses('from')[0],
    to: addresses('to'),
    cc: addresses('cc'),
    replyTo: addresses('reply-to'),
    subject: header('subject') ?? '',
    date: dateOf(header('date')),
    text: parsed.text,
    html: parsed.html,
    headers: parsed.headers,
    attachments,
    verdicts: row.provider === 'ses' ? row.verdicts : {},
  };
}
