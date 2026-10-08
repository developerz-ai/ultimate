// Web Push at boot: `pwa.push` read off the one config, the VAPID pair resolved from the boot's
// environment (refused before any service starts), and the runtime installed over the boot's own
// executor — so `pushSubscribe()`, `pushUnsubscribe()` and `webPush()` work in every role with no
// line of app wiring, and a deploy with no keys never boots.
//
// `@ultimat3/pwa` behind `await import()`: an app with push off — most of them — loads none of it
// into a worker or a migrate pod (`serve-graph.test.ts`), exactly as the nats client is opened.

import type { AppConfig, PgExecutor } from '@ultimat3/core';
import { logger, PWA_PUSH_FIX, pushWired } from '@ultimat3/core';
import type { ResolvedVapidKeys } from '@ultimat3/pwa';
import type { Env } from './runtime-bindings';

/** `pwa.vapid.subject` when this app's boot owes a push runtime, else `undefined`. */
export function pushSubjectOf(config: AppConfig | undefined): string | undefined {
  const pwa = config?.pwa;
  if (pwa === undefined || !pushWired(pwa)) return undefined;
  // `pushWired` checked the block is there; `defineConfig` checked its subject is one a push
  // service takes (`pwaPushIssues`).
  return pwa.vapid?.subject;
}

export interface PushSelection {
  readonly subject: string;
  readonly resolved: ResolvedVapidKeys;
  /** `pwa.vapid.pushHosts`: push services beyond the built-in list. */
  readonly pushHosts: readonly string[];
}

/**
 * Pure apart from the key check — reads env, dials nothing — so it runs BEFORE the queue, beside
 * the mail driver's selection: a deploy missing `ULTIMATE_VAPID_PRIVATE_KEY` fails on the spot
 * with `X_PWA_VAPID_KEY_MISSING`, not after PGlite started, and never on the first push nobody got.
 */
export async function selectWebPush(
  config: AppConfig | undefined,
  env: Env,
): Promise<PushSelection | undefined> {
  const subject = pushSubjectOf(config);
  if (subject === undefined) {
    const pwa = config?.pwa;
    // Accepted for 26.0.0's sake, and never silent: the app asked for push and gets none.
    if (pwa?.enabled === true && pwa.push) {
      logger.warn('pwa.push unwired', {
        cause:
          'pwa.push is true and pwa.vapid is unset, so no push runtime, handler or key is wired',
        fix: PWA_PUSH_FIX,
      });
    }
    return undefined;
  }
  const { resolveVapidKeys } = await import('@ultimat3/pwa');
  return {
    subject,
    resolved: await resolveVapidKeys(env),
    pushHosts: config?.pwa.vapid?.pushHosts ?? [],
  };
}

/** Install the runtime over the boot's executor; answers its release. */
export async function installAppWebPush(
  selection: PushSelection,
  executor: PgExecutor,
): Promise<() => void> {
  const { installWebPush, postgresPushSubscriptionStore } = await import('@ultimat3/pwa');
  if (selection.resolved.source === 'development') {
    // Said once per boot: a reader seeing pushes arrive locally must know they are signed with a
    // pair printed in the framework's source, which no deploy accepts.
    logger.info('pwa.push development keys', {
      cause: 'ULTIMATE_VAPID_PUBLIC_KEY and ULTIMATE_VAPID_PRIVATE_KEY are unset',
      fix: 'x vapid create   # before the first deploy; a deployed boot refuses the development pair',
    });
  }
  return installWebPush({
    store: postgresPushSubscriptionStore({ executor }),
    keys: selection.resolved.keys,
    subject: selection.subject,
    pushHosts: selection.pushHosts,
  });
}
