// Single responsibility: `nativePush()`, the APNs + FCM transport as one `Pusher` — every device a
// person registered, each in its own locale, dead tokens deleted, refusals coded. It satisfies
// `pushChannel({ pusher })` for a visible push and `pushChannel({ pusher, data })` for a data-only
// one, which `webPush()` cannot (a browser push always shows) — so that mistake is a type error.

import type { Clock } from '@ultimat3/core';
import { finiteCount, isUltimateError, logger, systemClock } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import { translatorFor } from '@ultimat3/i18n';
import type { ApnsOptions } from './apns';
import { apnsSender } from './apns';
import type { DataPusher, NotifyPushMessage, Pusher } from './channel-push';
import type { FcmOptions } from './fcm';
import { fcmSender } from './fcm';
import { platformFetch } from './native-transport';
import type { PushDeviceStore, PushPlatform } from './push-device';
import { isDeviceToken } from './push-device';
import type { NativePush, NativeSender, PushData, PushTranslate } from './push-message';
import { renderNativePush, screenPushData } from './push-message';

export const DEFAULT_NATIVE_PUSH_DEADLINE_MS = 10_000;

/**
 * Bad-token answers in a row (APNs `BadDeviceToken`, FCM `INVALID_ARGUMENT` on `message.token`)
 * that delete a device. Never 1: `BadDeviceToken` is also a sandbox build's token sent to
 * production, and a delivery in between starts the count again.
 */
export const PUSH_BAD_TOKEN_LIMIT = 3;

export interface NativePushOptions {
  /** The registrations `pushRegister()` writes — the same store, handed to both. */
  readonly devices: PushDeviceStore;
  /** iOS devices. Absent, an `ios` registration is skipped with a warning. */
  readonly apns?: ApnsOptions | undefined;
  /** Android devices. Absent, an `android` registration is skipped with a warning. */
  readonly fcm?: FcmOptions | undefined;
  /** Each provider call, retries included. Default `DEFAULT_NATIVE_PUSH_DEADLINE_MS`. */
  readonly deadlineMs?: number | undefined;
  /** Test seams: the fake provider, the environment the keys are read from, the clock. */
  readonly fetch?: OutboundFetch | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly clock?: Clock | undefined;
  readonly translate?: ((locale: string) => PushTranslate) | undefined;
}

/** Both seams, each answering a promise: a send settles once every device was tried. */
export interface NativePusher extends Pusher, DataPusher {
  send(push: Parameters<Pusher['send']>[0]): Promise<void>;
  sendData(push: Parameters<DataPusher['sendData']>[0]): Promise<void>;
}

/** The message for one device, in that device's locale. */
type PushFor = (locale: string) => NativePush;

type Senders = ReadonlyMap<PushPlatform, NativeSender>;

const metaOf = (error: { readonly meta?: Readonly<Record<string, unknown>> | undefined }) =>
  error.meta ?? {};

/**
 * Every device of `to`, in `(platform, token)` order. A dead token is deleted; a token the
 * provider cannot parse is deleted on its `PUSH_BAD_TOKEN_LIMIT`th answer in a row; a refusal for
 * good is logged with its code and the next device tried; a blip (a 5xx, a 429, a timeout) is
 * rethrown AFTER every other device was tried, for the job's retry. A CREDENTIAL refusal ends that
 * provider's fan-out on the spot and is thrown — every other device would be refused alike, each
 * after a re-sign Apple throttles. When no device took it and one refused, the first refusal is
 * thrown: a delivery nothing accepted must fail, not settle as sent.
 */
async function eachDevice(
  devices: PushDeviceStore,
  senders: Senders,
  push: { readonly to: string; readonly signal: AbortSignal; readonly message: PushFor },
): Promise<void> {
  let delivered = 0;
  let retry: unknown;
  let refusal: unknown;
  let credential: unknown;
  const stopped = new Set<PushPlatform>();
  for (const device of await devices.listFor(push.to)) {
    if (stopped.has(device.platform)) continue;
    const sender = senders.get(device.platform);
    if (sender === undefined) {
      logger.warn('notify.push.unconfigured', {
        platform: device.platform,
        fix: `nativePush({ ${device.platform === 'ios' ? 'apns' : 'fcm'}: { … } })   # or drop '${device.platform}' from pushRegister({ platforms })`,
      });
      continue;
    }
    // A stored token no provider could take is a row no send will ever reach.
    if (!isDeviceToken(device.platform, device.token)) {
      await devices.remove(device.platform, device.token);
      continue;
    }
    try {
      await sender.send(device.token, push.message(device.locale), push.signal);
      delivered += 1;
      if ((device.badTokens ?? 0) > 0) await devices.clearBadToken(device.platform, device.token);
    } catch (error) {
      if (!isUltimateError(error) || !error.code.startsWith('X_NOTIFY_PUSH_')) {
        retry ??= error;
        continue;
      }
      if (error.code === 'X_NOTIFY_PUSH_DEVICE_GONE') {
        await devices.remove(device.platform, device.token);
        logger.info('notify.push.gone', { code: error.code, cause: error.cause });
        continue;
      }
      logger.error('notify.push.refused', { code: error.code, cause: error.cause, fix: error.fix });
      const meta = metaOf(error);
      if (meta['credential'] === true) {
        stopped.add(device.platform);
        credential ??= error;
        continue;
      }
      refusal ??= error;
      if (
        meta['badToken'] === true &&
        (await devices.noteBadToken(device.platform, device.token)) >= PUSH_BAD_TOKEN_LIMIT
      ) {
        await devices.remove(device.platform, device.token);
        logger.info('notify.push.bad_token_removed', { code: error.code, cause: error.cause });
      }
    }
  }
  if (credential !== undefined) throw credential;
  if (retry !== undefined) throw retry;
  if (delivered === 0 && refusal !== undefined) throw refusal;
}

/**
 * `pushChannel({ pusher: nativePush({ devices, apns: { teamId, keyId, topic }, fcm: { projectId,
 * clientEmail } }), message })`. The private keys are never options: they are read from
 * `ULTIMATE_APNS_PRIVATE_KEY` / `ULTIMATE_FCM_PRIVATE_KEY` (`x secrets set …`) when a token is
 * minted, boxed in a `Secret` at once, and signed with through WebCrypto.
 */
export function nativePush(options: NativePushOptions): NativePusher {
  const deps = {
    fetch: options.fetch ?? platformFetch,
    env: options.env ?? Bun.env,
    // Real time: a provider JWT's `iat` is judged by APNs/FCM against their own clocks.
    clock: options.clock ?? systemClock,
    deadlineMs: finiteCount(
      'nativePush()',
      'deadlineMs',
      options.deadlineMs ?? DEFAULT_NATIVE_PUSH_DEADLINE_MS,
      1,
    ),
  };
  const senders = new Map<PushPlatform, NativeSender>();
  if (options.apns !== undefined) senders.set('ios', apnsSender(options.apns, deps));
  if (options.fcm !== undefined) senders.set('android', fcmSender(options.fcm, deps));
  const translate = options.translate ?? ((locale: string) => translatorFor(locale));
  return {
    send({ to, message, signal }: { to: string; message: NotifyPushMessage; signal: AbortSignal }) {
      return eachDevice(options.devices, senders, {
        to,
        signal,
        message: (locale) => ({
          kind: 'alert',
          push: renderNativePush(message, translate(locale)),
        }),
      });
    },
    sendData({ to, data, signal }: { to: string; data: PushData; signal: AbortSignal }) {
      // Screened once, before any device: a refusal here is the notifier's, not a provider's.
      const screened = screenPushData(data);
      return eachDevice(options.devices, senders, {
        to,
        signal,
        message: () => ({ kind: 'data', data: screened }),
      });
    },
  };
}
