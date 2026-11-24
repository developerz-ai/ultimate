// Single responsibility: what a native push SAYS, before any provider's wire shape — a visible one
// rendered from catalog keys in the device's locale, or a data-only one screened down to ids. The
// APNs and FCM bodies are built from this and from nothing else, so nothing else can leave.

import { finiteCount } from '@ultimat3/core';
import type { NotifyPushMessage } from './channel-push';
import { NotifyPushMessageInvalidError } from './push-errors';

/** A data-only push's payload: string ids, never content. */
export type PushData = Readonly<Record<string, string>>;

export const DATA_PUSH_MAX_KEYS = 8;
export const DATA_PUSH_MAX_VALUE = 256;
/** The default hold for an offline device, as the web channel's: one day. */
export const DEFAULT_PUSH_TTL_SECONDS = 86_400;

const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Keys a provider owns. `aps` would overwrite APNs' own dictionary, and FCM refuses the rest with a
 * 400 — refused here, before a send, with the key named.
 */
const RESERVED = new Set(['aps', 'from', 'notification', 'message_type', 'collapse_key', 'ttl']);
const RESERVED_PREFIX = /^(?:google|gcm)/i;

/** `data` as the wire may carry it, or `X_NOTIFY_PUSH_MESSAGE_INVALID` naming what is wrong. */
export function screenPushData(data: unknown): PushData {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new NotifyPushMessageInvalidError({ problem: 'is not an object of strings' });
  }
  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw new NotifyPushMessageInvalidError({ problem: 'is empty, so the app wakes to nothing' });
  }
  if (entries.length > DATA_PUSH_MAX_KEYS) {
    throw new NotifyPushMessageInvalidError({
      problem: `holds ${String(entries.length)} keys and at most ${String(DATA_PUSH_MAX_KEYS)} are allowed`,
    });
  }
  const screened = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!DATA_KEY.test(key)) {
      throw new NotifyPushMessageInvalidError({ problem: 'names a key that is not an identifier' });
    }
    if (RESERVED.has(key) || RESERVED_PREFIX.test(key)) {
      throw new NotifyPushMessageInvalidError({
        problem: `names the provider-reserved key "${key}"`,
      });
    }
    if (typeof value !== 'string' || value.length > DATA_PUSH_MAX_VALUE) {
      throw new NotifyPushMessageInvalidError({
        problem: `holds "${key}" as something other than a string of at most ${String(DATA_PUSH_MAX_VALUE)} characters`,
      });
    }
    screened.set(key, value);
  }
  return Object.freeze(Object.fromEntries(screened));
}

/** Renders one catalog key; `@ultimat3/i18n`'s `translatorFor(locale)` unless a test hands one. */
export type PushTranslate = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

/** A visible push as both providers read it: text in one locale, plus how it travels. */
export interface RenderedNativePush {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** Replaces an earlier notification carrying it — `topic`, else `tag`. */
  readonly collapse: string | undefined;
  readonly ttlSeconds: number;
  readonly urgent: boolean;
  /**
   * Both providers. Absent, no sound is requested: APNs shows the alert silently, and on Android 8
   * and later the notification channel's sound plays. `'default'` asks for the platform's sound.
   */
  readonly sound?: string | undefined;
  /** APNs only. */
  readonly interruptionLevel?: NativeInterruptionLevel | undefined;
  /** APNs only. */
  readonly category?: string | undefined;
  /** FCM only. */
  readonly channelId?: string | undefined;
}

export type NativeInterruptionLevel = 'passive' | 'active' | 'time-sensitive' | 'critical';

const INTERRUPTION_LEVELS: ReadonlySet<string> = new Set([
  'passive',
  'active',
  'time-sensitive',
  'critical',
]);

/** A sound file, a category or a channel id: a short name, never text a person reads. */
const NATIVE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The native-only fields of a visible push, screened once before any device: a name each provider
 * takes as it is, or `X_NOTIFY_PUSH_MESSAGE_INVALID` naming the field.
 */
export function screenNativeFields(message: NotifyPushMessage): void {
  for (const field of ['sound', 'category', 'channelId'] as const) {
    const value: unknown = message[field];
    if (value !== undefined && (typeof value !== 'string' || !NATIVE_NAME.test(value))) {
      throw new NotifyPushMessageInvalidError({
        field,
        problem: `is not a name of 1 to 64 letters, digits, '.', '_' or '-' (${String(NATIVE_NAME)})`,
      });
    }
  }
  const level: unknown = message.interruptionLevel;
  if (level !== undefined && (typeof level !== 'string' || !INTERRUPTION_LEVELS.has(level))) {
    throw new NotifyPushMessageInvalidError({
      field: 'interruptionLevel',
      problem: `is not one of ${[...INTERRUPTION_LEVELS].join(', ')}`,
    });
  }
}

/**
 * The web-only fields (`icon`, `badge`, `actions`, `requireInteraction`, `renotify`) have no
 * native meaning here and are not sent: an app's native shell decides how its alerts look. The
 * native-only ones (`sound`, `interruptionLevel`, `category`, `channelId`) pass through as given,
 * screened by `screenNativeFields`.
 */
export function renderNativePush(
  message: NotifyPushMessage,
  translate: PushTranslate,
): RenderedNativePush {
  const collapse = message.topic ?? message.tag;
  return {
    title: translate(message.titleKey, message.params),
    body: translate(message.bodyKey, message.params),
    url: message.url,
    collapse: collapse === undefined || collapse === '' ? undefined : collapse,
    ttlSeconds: finiteCount(
      'pushChannel()',
      'ttlSeconds',
      message.ttlSeconds ?? DEFAULT_PUSH_TTL_SECONDS,
    ),
    urgent:
      message.urgency === undefined || message.urgency === 'normal' || message.urgency === 'high',
    // Only the fields set: an alert without them renders exactly as it did before they existed.
    ...(message.sound === undefined ? {} : { sound: message.sound }),
    ...(message.interruptionLevel === undefined
      ? {}
      : { interruptionLevel: message.interruptionLevel }),
    ...(message.category === undefined ? {} : { category: message.category }),
    ...(message.channelId === undefined ? {} : { channelId: message.channelId }),
  };
}

/** What one device's send carries: a rendered alert, or ids that wake the app and show nothing. */
export type NativePush =
  | { readonly kind: 'alert'; readonly push: RenderedNativePush }
  | { readonly kind: 'data'; readonly data: PushData };

/** One provider, one device. `apns.ts` and `fcm.ts` are the two. */
export interface NativeSender {
  send(token: string, push: NativePush, signal: AbortSignal): Promise<void>;
}
