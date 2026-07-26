/**
 * Web Push: subscription lifecycle, VAPID config, typed payloads, and a per-locale body.
 *
 * The locale is stored ON the subscription, not read from the sending request: a push is
 * composed on a server with no request context, and a notification in the wrong language
 * is a real bug that users report as "the app is broken".
 */

export interface VapidConfig {
  readonly publicKey: string;
  /** `mailto:` or an https URL — required by the spec, checked by every push service. */
  readonly subject: string;
}

export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
  /** BCP-47, captured at subscribe time. */
  readonly locale: string;
  readonly timeZone: string;
  readonly actorId: string | null;
  readonly createdAt: number;
  readonly expirationTime: number | null;
}

export type SubscriptionState = 'active' | 'expired' | 'gone';

/** A 404/410 from the push service means the subscription is dead — delete it, don't retry. */
export function subscriptionState(
  record: PushSubscriptionRecord,
  lastStatus: number | null,
  now = Date.now(),
): SubscriptionState {
  if (lastStatus === 404 || lastStatus === 410) return 'gone';
  if (record.expirationTime !== null && record.expirationTime <= now) return 'expired';
  return 'active';
}

/** Translation function from `@ultimat3/i18n`, bound to the subscriber's locale. */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface PushPayload {
  /** i18n catalog keys, never literal strings. */
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Deep link opened by `notificationclick`. */
  readonly url: string;
  /** Collapse key: a newer notification with the same tag replaces the older one. */
  readonly tag?: string;
  readonly icon?: string;
  readonly badge?: string;
  readonly renotify?: boolean;
  readonly requireInteraction?: boolean;
  readonly actions?: readonly { readonly action: string; readonly titleKey: string }[];
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string | null;
  readonly icon: string | null;
  readonly badge: string | null;
  readonly renotify: boolean;
  readonly requireInteraction: boolean;
  readonly actions: readonly { readonly action: string; readonly title: string }[];
  readonly locale: string;
  /** Missing-key markers (`⟦key⟧`) surfaced instead of being shipped to a user. */
  readonly warnings: readonly string[];
}

const MISSING_MARKER = '⟦';

export function renderPushPayload(
  payload: PushPayload,
  locale: string,
  translate: Translate,
): RenderedNotification {
  const warnings: string[] = [];
  const render = (key: string): string => {
    const value = translate(key, payload.params);
    if (value.startsWith(MISSING_MARKER)) {
      warnings.push(`missing ${locale} translation for ${key}`);
    }
    return value;
  };

  return {
    title: render(payload.titleKey),
    body: render(payload.bodyKey),
    url: payload.url,
    tag: payload.tag ?? null,
    icon: payload.icon ?? null,
    badge: payload.badge ?? null,
    renotify: payload.renotify ?? false,
    requireInteraction: payload.requireInteraction ?? false,
    actions: (payload.actions ?? []).map((action) => ({
      action: action.action,
      title: render(action.titleKey),
    })),
    locale,
    warnings,
  };
}

/** The wire body the SW receives. Rendered server-side so the SW ships no catalog. */
export function serializePushMessage(notification: RenderedNotification): string {
  return JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url,
    tag: notification.tag,
    icon: notification.icon,
    badge: notification.badge,
    renotify: notification.renotify,
    requireInteraction: notification.requireInteraction,
    actions: notification.actions,
    lang: notification.locale,
  });
}

export interface PushSourceOptions {
  readonly defaultIcon?: string;
  readonly defaultBadge?: string;
  /** Emit `navigator.setAppBadge` calls — gated by the `badging` capability. */
  readonly badging?: boolean;
}

/** Emitted into `sw.js` only when the `push` capability is on. */
export function pushSource(options: PushSourceOptions = {}): string {
  const icon = JSON.stringify(options.defaultIcon ?? '/icons/icon-192.png');
  const badge = JSON.stringify(options.defaultBadge ?? '/icons/icon-mono-512.png');
  const badging = options.badging === true;

  return `
self.addEventListener('push',(event)=>{
  const d=event.data?event.data.json():{};
  const opts={body:d.body||'',icon:d.icon||${icon},badge:d.badge||${badge},
    tag:d.tag||undefined,renotify:!!d.renotify,requireInteraction:!!d.requireInteraction,
    lang:d.lang||undefined,actions:d.actions||[],data:{url:d.url||'/'}};
  event.waitUntil(self.registration.showNotification(d.title||'',opts)${
    badging ? '.then(()=>navigator.setAppBadge&&navigator.setAppBadge())' : ''
  });
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close();
  const url=(event.notification.data&&event.notification.data.url)||'/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then((ws)=>{
    for(const w of ws){if(w.url===url&&'focus'in w)return w.focus()}
    return clients.openWindow(url)
  }));
});`.trim();
}

/** Client-side subscribe. The locale travels with the subscription, by design. */
export function subscribeSource(vapid: VapidConfig): string {
  return `
export async function subscribePush(registration,locale,timeZone){
  const existing=await registration.pushManager.getSubscription();
  if(existing)return {subscription:existing.toJSON(),locale,timeZone};
  const sub=await registration.pushManager.subscribe({userVisibleOnly:true,
    applicationServerKey:${JSON.stringify(vapid.publicKey)}});
  return {subscription:sub.toJSON(),locale,timeZone}
}`.trim();
}
