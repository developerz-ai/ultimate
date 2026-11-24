// Single responsibility: the native push transport's three refusals. Registered with the rest of
// the package's codes in `errors.ts`; here so that file stays the fan-out's. No cause ever carries
// a device token, a credential or a message body — only the provider, its status and its reason.

import { UltimateError } from '@ultimat3/core';

export type PushProvider = 'apns' | 'fcm';

/** The provider's reason word (`Unregistered`, `UNREGISTERED`), or `unknown` — never free text. */
export const providerReason = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z_]{1,64}$/.test(value) ? value : 'unknown';

/**
 * The provider says this token names no install any more: APNs 410, FCM `UNREGISTERED`. Thrown by
 * one device's send and caught by `nativePush()`, which deletes the row and logs this — so it
 * never fails a delivery, and the next notification does not pay for the dead device again.
 */
export class NotifyPushDeviceGoneError extends UltimateError {
  constructor(input: { provider: PushProvider; status: number; reason: string }) {
    super({
      code: 'X_NOTIFY_PUSH_DEVICE_GONE',
      cause: `${input.provider} answered ${String(input.status)} (${input.reason}) for a device token: the app was uninstalled, or the device rotated its token`,
      fix: 'x jobs list --json   # nothing to repair: the dead device row is already deleted, and the app stores its new token with its next pushRegister() call',
      meta: { provider: input.provider, status: input.status, reason: input.reason },
    });
  }
}

/** Spelled per provider rather than interpolated: a `fix:` names its command whole. */
const APNS_CREDENTIAL_FIX =
  "x secrets set ULTIMATE_APNS_PRIVATE_KEY   # with the team's current .p8 key, and check teamId, keyId and topic on nativePush({ apns })";
const FCM_CREDENTIAL_FIX =
  "x secrets set ULTIMATE_FCM_PRIVATE_KEY   # with the service account's current private_key, and check projectId and clientEmail on nativePush({ fcm })";

const REQUEST_FIX =
  'x jobs list --json   # read meta.reason on the failed step, then fix the topic, project or message nativePush() was given';

/**
 * A refusal the same request gets again: a credential, a topic or project, a payload limit.
 * `meta.credential` (a 401/403, or Google refusing the assertion) ends that provider's fan-out in
 * `nativePush()`: every other device would be refused the same way, each after a re-sign.
 * `meta.badToken` (APNs `BadDeviceToken`, FCM `INVALID_ARGUMENT` on `message.token`) counts
 * against that one device row.
 */
export class NotifyPushProviderRefusedError extends UltimateError {
  constructor(input: {
    provider: PushProvider;
    status: number;
    reason: string;
    credential?: boolean | undefined;
    badToken?: boolean | undefined;
  }) {
    const credential = input.credential ?? (input.status === 401 || input.status === 403);
    super({
      code: 'X_NOTIFY_PUSH_PROVIDER_REFUSED',
      cause: `${input.provider} answered ${String(input.status)} (${input.reason}), and the same request will be refused again`,
      fix: credential
        ? input.provider === 'apns'
          ? APNS_CREDENTIAL_FIX
          : FCM_CREDENTIAL_FIX
        : REQUEST_FIX,
      meta: {
        provider: input.provider,
        status: input.status,
        reason: input.reason,
        credential,
        badToken: input.badToken === true,
      },
    });
  }
}

const DATA_FIX =
  'pushChannel({ pusher, data: ({ event }) => ({ id: event.params.id }) })   # in the notifier: one id per push, the app fetches the rest over its API';

/** Each a valid edit of the notifier's own `message`: the field set, everything else kept. */
const FIELD_FIX = {
  sound:
    "pushChannel({ pusher, message: (args) => ({ ...message(args), sound: 'default' }) })   # or a sound the app bundles: APNs takes its file name, FCM its res/raw name without the extension; 1 to 64 of A-Za-z0-9._-",
  category:
    "pushChannel({ pusher, message: (args) => ({ ...message(args), category: 'reply' }) })   # a category the iOS app registered; 1 to 64 of A-Za-z0-9._-",
  channelId:
    "pushChannel({ pusher, message: (args) => ({ ...message(args), channelId: 'mentions' }) })   # a channel the Android app created; 1 to 64 of A-Za-z0-9._-",
  interruptionLevel:
    "pushChannel({ pusher, message: (args) => ({ ...message(args), interruptionLevel: 'time-sensitive' }) })   # one of passive, active, time-sensitive, critical: fixed by APNs, critical needs Apple's entitlement",
} as const;

/**
 * A data-only push carrying more than an id: a reserved key, too many keys, a long value. Or, with
 * `field`, a visible native push whose sound, category, channel or interruption level no provider
 * would take.
 */
export class NotifyPushMessageInvalidError extends UltimateError {
  constructor(input: {
    problem: string;
    field?: 'sound' | 'category' | 'channelId' | 'interruptionLevel' | undefined;
  }) {
    const { field } = input;
    super({
      code: 'X_NOTIFY_PUSH_MESSAGE_INVALID',
      cause:
        field === undefined
          ? `the data of a data-only push ${input.problem}; it travels through the provider, so it carries ids and nothing a person would read`
          : field === 'interruptionLevel'
            ? `the interruptionLevel of a native push ${input.problem}; APNs takes only these fixed values`
            : `the ${field} of a native push ${input.problem}; the provider takes it as a name the app registered or bundles`,
      fix: field === undefined ? DATA_FIX : FIELD_FIX[field],
      meta: field === undefined ? { problem: input.problem } : { problem: input.problem, field },
    });
  }
}
