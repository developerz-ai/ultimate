// Single responsibility: the BROWSER half of Web Push — ask for permission, subscribe with the
// server's VAPID public key, hand the subscription to the app's `pushSubscribe()` action, and undo
// it. `@ultimat3/pwa/client`, a subpath of its own with NO imports, so an island that offers a
// "notify me" button pays for these lines and nothing of the server package.
//
//   import { subscribeToPush } from '@ultimat3/pwa/client';
//   import { client } from '../../shared/browser-client';
//   onClick={() => subscribeToPush({ save: client.subscribePush })}
//
// The key is read from `<meta name="x-push-key">`, which the web role writes into every document
// once push is configured — so no app passes, bundles or fetches it, and a key rotation reaches
// every page on its next render.

/** The `<meta name>` the web role emits; `@ultimat3/cli` writes it, this reads it. */
export const PUSH_KEY_META = 'x-push-key';

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * What `subscribeToPush` answers. Every branch is an outcome the app renders, not an exception:
 * `denied` is a person's decision, `unsupported` a browser's (iOS before it is installed to the
 * home screen), `unconfigured` a page served with no push key.
 */
export type PushSubscribeOutcome =
  | { readonly status: 'subscribed'; readonly endpoint: string }
  | { readonly status: 'denied' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'unconfigured' };

/** What the `pushSubscribe()` action takes — `PushSubscription.toJSON()` plus locale and zone. */
export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly locale: string;
  readonly timeZone: string;
}

/** The browser surface this module touches — injectable, so a test runs it without a browser. */
export interface PushClientHost {
  readonly serviceWorker: { readonly ready: Promise<PushRegistrationLike> } | undefined;
  readonly notification:
    | {
        readonly permission: 'default' | 'denied' | 'granted';
        requestPermission(): Promise<'default' | 'denied' | 'granted'>;
      }
    | undefined;
  /** `<meta name="x-push-key">`'s content, or `null`. */
  readonly pushKey: string | null;
  /** `<html lang>` — the locale this page was rendered in, so the one a notification renders in. */
  readonly locale: string;
  /** The device's IANA zone. */
  readonly timeZone: string;
}

export interface PushRegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  };
}

export interface PushSubscriptionLike {
  readonly endpoint: string;
  toJSON(): {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: Record<string, string>;
  };
  unsubscribe(): Promise<boolean>;
}

/** The real browser, read at call time — never at import, which may run during a server render. */
export function browserPushHost(): PushClientHost {
  const nav = globalThis.navigator as Navigator | undefined;
  const supported =
    nav !== undefined && 'serviceWorker' in nav && typeof globalThis.PushManager === 'function';
  const meta = globalThis.document?.querySelector(`meta[name="${PUSH_KEY_META}"]`);
  return {
    serviceWorker: supported
      ? (nav.serviceWorker as unknown as PushClientHost['serviceWorker'])
      : undefined,
    notification:
      typeof globalThis.Notification === 'function'
        ? (globalThis.Notification as unknown as PushClientHost['notification'])
        : undefined,
    pushKey: meta?.getAttribute('content') ?? null,
    locale: globalThis.document?.documentElement.lang || 'en',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Where this browser stands, without asking anything. */
export function pushPermission(host: PushClientHost = browserPushHost()): PushPermission {
  if (host.serviceWorker === undefined || host.notification === undefined) return 'unsupported';
  const state = host.notification.permission;
  return state === 'default' ? 'prompt' : state;
}

function keyBytes(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Ask, subscribe, save. Call it from a click: browsers refuse a permission prompt that no user
 * gesture asked for. An existing subscription is saved again rather than replaced — it re-binds
 * the device to whoever is signed in now, and keeps the locale current.
 */
export async function subscribeToPush(
  options: { readonly save: (input: PushSubscriptionInput) => Promise<unknown> },
  host: PushClientHost = browserPushHost(),
): Promise<PushSubscribeOutcome> {
  if (host.serviceWorker === undefined || host.notification === undefined) {
    return { status: 'unsupported' };
  }
  if (host.pushKey === null || host.pushKey === '') return { status: 'unconfigured' };
  const permission =
    host.notification.permission === 'default'
      ? await host.notification.requestPermission()
      : host.notification.permission;
  if (permission !== 'granted') return { status: 'denied' };
  const registration = await host.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(host.pushKey),
    }));
  const json = subscription.toJSON();
  await options.save({
    endpoint: subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' },
    locale: host.locale,
    timeZone: host.timeZone,
  });
  return { status: 'subscribed', endpoint: subscription.endpoint };
}

/**
 * Tell the server first, then the browser: the other order leaves a row the sender meets as a 410
 * at best, and as notifications to a device the person turned off at worst, if the call fails.
 * `false` when this browser held no subscription.
 */
export async function unsubscribeFromPush(
  options: { readonly remove: (input: { readonly endpoint: string }) => Promise<unknown> },
  host: PushClientHost = browserPushHost(),
): Promise<boolean> {
  if (host.serviceWorker === undefined) return false;
  const registration = await host.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return false;
  await options.remove({ endpoint: subscription.endpoint });
  return subscription.unsubscribe();
}
