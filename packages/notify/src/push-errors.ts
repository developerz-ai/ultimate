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

/** A data-only push carrying more than an id: a reserved key, too many keys, a long value. */
export class NotifyPushMessageInvalidError extends UltimateError {
  constructor(input: { problem: string }) {
    super({
      code: 'X_NOTIFY_PUSH_MESSAGE_INVALID',
      cause: `the data of a data-only push ${input.problem}; it travels through the provider, so it carries ids and nothing a person would read`,
      fix: 'pushChannel({ pusher, data: ({ event }) => ({ id: event.params.id }) })   # in the notifier: one id per push, the app fetches the rest over its API',
      meta: { problem: input.problem },
    });
  }
}
