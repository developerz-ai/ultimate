// Single responsibility: the one Web Push runtime a process holds — the subscription store, the
// imported VAPID signer, and the transport — installed by the boot and read per call by the
// subscribe actions and the sender.
//
// Read PER CALL, never captured at declaration: an app's `pushSubscribe()` is declared when its
// modules import, and the boot installs this before that (`@ultimat3/cli`'s `runtime-services.ts`)
// — but a test installs its own after, and a captured value would be the previous test's.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { translatorFor } from '@ultimat3/i18n';
import { PwaPushUnconfiguredError } from './errors';
import type { Translate, VapidConfig } from './push';
import type { VapidSigner } from './push-send';
import type { PushSubscriptionStore } from './push-store';
import type { VapidKeyPair } from './vapid';
import { importVapidKeys } from './vapid';

export interface WebPushOptions {
  readonly store: PushSubscriptionStore;
  /** The pair `resolveVapidKeys` answered — the boot checked it is one. */
  readonly keys: VapidKeyPair;
  /** `pwa.vapid.subject`: `mailto:` or `https:`. */
  readonly subject: string;
  readonly fetch?: typeof fetch | undefined;
  readonly clock?: Clock | undefined;
  /** `pwa.vapid.pushHosts`: push services beyond the built-in list, at subscribe and at send. */
  readonly pushHosts?: readonly string[] | undefined;
  /**
   * The catalog a subscriber's locale renders from. `@ultimat3/i18n`'s `translatorFor` — the app's
   * registered catalogs — unless a test hands its own.
   */
  readonly translate?: ((locale: string) => Translate) | undefined;
}

export interface WebPushRuntime {
  readonly store: PushSubscriptionStore;
  readonly signer: VapidSigner;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly translate: (locale: string) => Translate;
  readonly pushHosts: readonly string[];
}

let installed: WebPushRuntime | undefined;

/**
 * Install the runtime and answer its release. Whole-object replacement, never a merge. The key is
 * imported once here, not per send: a notifier fanning out to a thousand devices signs a thousand
 * tokens with one `CryptoKey`.
 */
export async function installWebPush(options: WebPushOptions): Promise<() => void> {
  const keys = await importVapidKeys(options.keys);
  const runtime: WebPushRuntime = {
    store: options.store,
    signer: { keys, publicKey: options.keys.publicKey, subject: options.subject },
    fetch: options.fetch ?? fetch,
    clock: options.clock ?? systemClock,
    translate: options.translate ?? ((locale) => translatorFor(locale)),
    pushHosts: options.pushHosts ?? [],
  };
  installed = runtime;
  return () => {
    if (installed === runtime) installed = undefined;
  };
}

/** The installed runtime, or `X_PWA_PUSH_UNCONFIGURED` naming what tried to use it. */
export function webPushRuntime(operation: string): WebPushRuntime {
  if (installed === undefined) throw new PwaPushUnconfiguredError({ operation });
  return installed;
}

/**
 * The public half a browser subscribes with and the subject, or `undefined` when no runtime is
 * installed — what the web role writes into `<meta name="x-push-key">` and gates `sw.js`'s push
 * handler on.
 */
export const installedVapid = (): VapidConfig | undefined =>
  installed === undefined
    ? undefined
    : { publicKey: installed.signer.publicKey, subject: installed.signer.subject };

/** Test seam. */
export function resetWebPush(): void {
  installed = undefined;
}
