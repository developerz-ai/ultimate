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
}

/**
 * The web-only fields (`icon`, `badge`, `actions`, `requireInteraction`, `renotify`) have no
 * native meaning here and are not sent: an app's native shell decides how its alerts look.
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
