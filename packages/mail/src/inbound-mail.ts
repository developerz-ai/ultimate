// Single responsibility: `inboundMail()` — received email as a factory over jobs'
// `webhookReceiver()` (itself a factory over `job`), never a ninth primitive. The door is the
// provider's: signature first, then the envelope, then a durable row. The job reads the raw MIME,
// parses it under bounds, stores the attachments and hands the app ONE typed `InboundMessage`.

import { ConfigInvalidError, finiteCount } from '@ultimat3/core';
import { type WebhookReceiver, webhookReceiver } from '@ultimat3/jobs';
import { assertSafeKey } from '@ultimat3/storage';
import { DEFAULT_INBOUND_PREFIX } from './inbound-attachments';
import { readInbound } from './inbound-message';
import type { InboundMailDefinition, InboundRow, WebhookInbound } from './inbound-types';
import { DEFAULT_MIME_LIMITS, type MimeLimits } from './mime-parse';

const LIMIT_NAMES = [
  'maxBytes',
  'maxParts',
  'maxDepth',
  'maxAttachments',
  'maxHeaderBytes',
] as const;

/** Every bound screened where it is declared: `size > NaN` is false, so NaN would bound nothing. */
function limitsOf(declared: Partial<MimeLimits> | undefined): MimeLimits {
  const out: Record<(typeof LIMIT_NAMES)[number], number> = { ...DEFAULT_MIME_LIMITS };
  for (const name of LIMIT_NAMES) {
    const value = declared?.[name];
    if (value !== undefined) out[name] = finiteCount('inboundMail', `limits.${name}`, value, 1);
  }
  return out;
}

export function inboundMail(definition: InboundMailDefinition): WebhookReceiver {
  const { provider, tenant } = definition;
  if (typeof provider?.door !== 'function' || typeof provider.mime !== 'function') {
    throw new ConfigInvalidError({
      cause: `inboundMail '${String(definition.name)}' has no provider`,
      fix: "inboundMail({ provider: sesInbound({ topicArns }) }) — or resendInbound({ secret, apiKey }), from '@ultimat3/mail/inbound'",
    });
  }
  const limits = limitsOf(definition.limits);
  const attachments = definition.attachments ?? {};
  // Screened at boot: a prefix storage refuses must not read, per file, as a policy refusal.
  if (attachments !== false) assertSafeKey(attachments.prefix ?? DEFAULT_INBOUND_PREFIX);

  return webhookReceiver<InboundRow>({
    name: definition.name,
    path: definition.path,
    tenant: tenant === 'none' ? 'none' : (facts) => facts.orgId,
    maxBytes: provider.maxBodyBytes,
    ...(definition.retry === undefined ? {} : { retry: definition.retry }),
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.rateLimit === undefined ? {} : { rateLimit: definition.rateLimit }),
    async verify(inbound: WebhookInbound) {
      const door = await provider.door(inbound);
      if ('answer' in door) return door;
      const orgId = tenant === 'none' ? undefined : tenant(door.row.recipients);
      return {
        eventId: door.eventId,
        payload: door.row,
        ...(orgId === undefined ? {} : { orgId }),
      };
    },
    async handle({ eventId, orgId, payload, ctx, step, attempt }) {
      const message = await readInbound({ provider, eventId, orgId, payload, limits, attachments });
      return definition.handle({ message, orgId, ctx, step, attempt });
    },
  });
}
