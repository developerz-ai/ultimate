// Single responsibility: the subscription surface, as two FACTORIES OVER `action` — never a ninth
// primitive and never a hand-mounted route. What they return is an action an app exports from its
// own actions module, so each one has its route, OpenAPI operation, typed client, contract tests
// and policy like any other write:
//
//   // apps/web/app/push/actions.ts
//   export const subscribePush = pushSubscribe({ permission: 'push:subscribe' });
//   export const unsubscribePush = pushUnsubscribe({ permission: 'push:subscribe' });
//
// The subscription is stored against `ctx.actor.id`, the person the request ran as — never an id
// the body names, so a caller can subscribe only themselves and unsubscribe only their own device.

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { KnownPermission, PolicyArgs, PolicyDecision } from '@ultimat3/policy';
import { can, denied } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { subscriptionKeyBytes } from './push-encrypt';
import { webPushRuntime } from './push-runtime';
import { assertPushEndpoint } from './push-send';

/** `PushSubscription.toJSON()`, plus the two facts a server-rendered notification needs. */
const subscribeInput = () =>
  t.object({
    endpoint: t.string.min(1).max(2048),
    expirationTime: t.nullable(t.number),
    keys: t.object({ p256dh: t.string.max(128), auth: t.string.max(64) }),
    /** BCP-47 — every notification to this device renders in it (`renderPushPayload`). */
    locale: t.locale,
    /** IANA — the zone a notification formatting a date would need. */
    timeZone: t.timezone,
  });

const subscribeOutput = () => t.object({ endpoint: t.string });
const unsubscribeInput = () => t.object({ endpoint: t.string.min(1).max(2048) });
const unsubscribeOutput = () => t.object({ removed: t.boolean });

type SubscribeInput = ReturnType<typeof subscribeInput>;
type SubscribeOutput = ReturnType<typeof subscribeOutput>;
type UnsubscribeInput = ReturnType<typeof unsubscribeInput>;
type UnsubscribeOutput = ReturnType<typeof unsubscribeOutput>;

export interface PushSubscriptionActionOptions {
  /** What the subscribing actor must hold — read by `can()`, like every action's permission. */
  readonly permission: KnownPermission;
  /**
   * The app's further rule, over the actor. Absent, any actor holding the permission subscribes
   * themselves. An AGENT never does, whatever this says: a notification is for a person's device.
   */
  readonly check?: ((args: PolicyArgs<unknown, null>) => boolean | PolicyDecision) | undefined;
}

const policyOf = (options: PushSubscriptionActionOptions) =>
  can<unknown, null>(options.permission, (args) => {
    if (args.actor?.kind === 'agent') return denied('push.agent-subscriber');
    return options.check === undefined ? true : options.check(args);
  });

/** Store this browser's subscription for the person signed in. Idempotent per endpoint. */
export function pushSubscribe(
  options: PushSubscriptionActionOptions,
): Action<SubscribeInput, SubscribeOutput> {
  return action({
    input: subscribeInput(),
    output: subscribeOutput(),
    policy: policyOf(options),
    idempotent: true,
    async handle({ input, ctx }) {
      const runtime = webPushRuntime('pushSubscribe');
      // Refused before it is stored: an endpoint is where this server will POST, and only a push
      // service the app sends to is ever one (`push-hosts.ts`).
      assertPushEndpoint(input.endpoint, runtime.pushHosts);
      // Refused HERE rather than at the first send: a key no message can be encrypted for is a
      // subscription that fails every notification, silently, on a device that thinks it is on.
      subscriptionKeyBytes(input.keys);
      await runtime.store.save({
        endpoint: input.endpoint,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
        locale: input.locale,
        timeZone: input.timeZone,
        actorId: ctx.actor.id,
        createdAt: ctx.now().getTime(),
        expirationTime: input.expirationTime,
      });
      return { endpoint: input.endpoint };
    },
  });
}

/** Forget this browser's subscription — the caller's own only; another person's is absent. */
export function pushUnsubscribe(
  options: PushSubscriptionActionOptions,
): Action<UnsubscribeInput, UnsubscribeOutput> {
  return action({
    input: unsubscribeInput(),
    output: unsubscribeOutput(),
    policy: policyOf(options),
    idempotent: true,
    async handle({ input, ctx }) {
      const runtime = webPushRuntime('pushUnsubscribe');
      return { removed: await runtime.store.remove(input.endpoint, ctx.actor.id) };
    },
  });
}
