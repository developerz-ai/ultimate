// `webhookReceiver()` — one inbound webhook, declared as a `job` plus the plain route that feeds
// it: the twin of `webhook()`, and a factory over `job()`, never a ninth primitive. The route reads
// the exact bytes, asks the app's `verify`, enqueues durably and only then acknowledges; the job's
// body is the app's `handle`. Which vendors exist and what a payload means stay the app's (axiom 8).
//
// DEDUPE is the queue's live window, keyed by `eventId`: a redelivery while the job is live answers
// `deduped: true`. After it settles, `handle` is AT LEAST ONCE and receives `eventId` — the seen-set
// is the app's table. `verify` answers the payload it read AFTER the signature check; the row
// stores it `.sensitive()` (`x jobs show` masks it) and `handle` receives it, so no retry
// re-verifies against a vendor's window that has since closed.

import { ACTION_PATH_PREFIX } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { DEFAULT_WEBHOOK_BODY_LIMIT } from '@ultimat3/http';
import type { JsonValue } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { JobTenantMismatchError } from './errors-tenant';
import { job, registeredJobs } from './job';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';
import { WebhookReceiverInvalidError } from './webhook-receiver-errors';
import { receiverRoutes } from './webhook-receiver-route';
import type {
  WebhookReceiver,
  WebhookReceiverDefinition,
  WebhookReceiverInput,
} from './webhook-receiver-types';

const input = t.object({
  eventId: t.string,
  orgId: t.optional(t.string),
  topic: t.optional(t.string),
  payload: t.json().sensitive(),
});

/** Every handle `webhookReceiver()` built — so the boot can mount them without a second list. */
const receivers = new WeakSet<object>();

export function webhookReceiver<P extends JsonValue = JsonValue>(
  definition: WebhookReceiverDefinition<P>,
): WebhookReceiver {
  const maxBytes = assertReceiver(definition);
  const handle = job<WebhookReceiverInput>({
    name: definition.name,
    input,
    // `eventId` alone: the namespace is already (name, tenant, key), so one vendor event is one row.
    idempotencyKey: ({ eventId }) => eventId,
    tenant: tenantOf(definition),
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    run: ({ input: row, ctx, step, attempt }) =>
      definition.handle({
        eventId: row.eventId,
        orgId: row.orgId,
        topic: row.topic,
        // `verify` answered a `P` and the row holds exactly that JSON: the type it was stored as.
        payload: row.payload as P,
        ctx,
        step,
        attempt,
      }),
  });
  const routes = receiverRoutes({ definition, maxBytes, handle });
  // In place, never a copy: `isJobHandle` proves the object `job()` built, so a spread would stop
  // registering.
  const receiver = Object.assign(handle, { routes: () => routes });
  receivers.add(receiver);
  return receiver;
}

/**
 * The routes of every receiver declared in this process, in job-name order. The boot mounts these
 * beside `runtime.routes`: declaring a receiver is the one registration, never a second list.
 */
export function webhookReceiverRoutes(): readonly Route[] {
  return registeredJobs().flatMap((handle) =>
    receivers.has(handle) ? (handle as WebhookReceiver).routes() : [],
  );
}

function tenantOf<P extends JsonValue>(
  definition: WebhookReceiverDefinition<P>,
): JobTenant<WebhookReceiverInput> {
  const declared = definition.tenant;
  if (typeof declared !== 'function') return declared;
  return (row) => {
    const orgId = declared(row);
    if (typeof orgId === 'string' && orgId.length > 0) return orgId;
    throw new JobTenantMismatchError({
      job: definition.name,
      reason: 'declares an org tenant, and verify named no org for this delivery',
      fix: `webhookReceiver({ name: '${definition.name}', verify: (inbound) => ({ eventId, orgId }) }) — answer the org the delivery belongs to from verify`,
    });
  };
}

const RESERVED = [ACTION_PATH_PREFIX, '/_x'];

/** Every declaration refusal, at `webhookReceiver()`. Answers the resolved `maxBytes`. */
function assertReceiver<P extends JsonValue>(definition: WebhookReceiverDefinition<P>): number {
  const name = typeof definition.name === 'string' ? definition.name : '';
  const refuse = (field: string, reason: string, fix: string): never => {
    throw new WebhookReceiverInvalidError({ receiver: name, field, reason, fix });
  };
  if (name === '') refuse('name', 'is empty', "name: 'billing.events'");
  const path: unknown = definition.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length < 2 || path.endsWith('/')) {
    refuse('path', 'is not an absolute path like /hooks/billing', "path: '/hooks/<vendor>'");
  }
  for (const reserved of RESERVED) {
    if (path === reserved || String(path).startsWith(`${reserved}/`)) {
      refuse(
        'path',
        `sits under ${reserved}, which the framework serves`,
        "path: '/hooks/<vendor>'",
      );
    }
  }
  for (const field of ['verify', 'handle'] as const) {
    if (typeof definition[field] !== 'function') {
      refuse(field, 'is not a function', `${field}: (…) => …`);
    }
  }
  if (definition.handshake !== undefined && typeof definition.handshake !== 'function') {
    refuse('handshake', 'is set and is not a function', 'handshake: (inbound) => new Response(…)');
  }
  const maxBytes = definition.maxBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    refuse('maxBytes', 'is not a whole number of bytes, at least 1', 'maxBytes: 1_048_576');
  }
  return maxBytes;
}
