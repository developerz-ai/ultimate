// What a page needs to reach the sync node, composed ONCE for `x dev` and the container alike: the
// worker bundle and the page boot with their routes, the head a document carries (`ultimate-sync`,
// `ultimate-build`, `ultimate-sync-worker`, the boot script), and the persisted record types a
// private document names. One call from both boots, so the two cannot serve different targets.

import { persistedRecordTypes } from '@ultimat3/entity';
import type { Route } from '@ultimat3/http';
import type { ClientSyncHead } from '@ultimat3/render';
import { syncUrlFrom } from './sync-url';
import {
  buildPageBoot,
  buildSyncWorker,
  type FrameworkScript,
  pageBootRoutes,
  syncWorkerRoutes,
} from './worker-bundle';

export interface PageSync {
  readonly routes: readonly Route[];
  /** The scripts those routes serve, for the service worker to precache beside the islands. */
  readonly scripts: readonly FrameworkScript[];
  readonly head: ClientSyncHead;
  /**
   * The record types the app persists, read per render off the entity registry — the app's modules
   * register their entities during boot, so a value captured here could predate them.
   */
  readonly persisted: () => readonly string[];
}

/**
 * Built at boot and never on the watcher tick: the worker is framework code, not the app's, and a
 * worker that changes under tabs already running it is exactly what a source-addressed URL exists
 * to keep from happening mid-session.
 */
export async function pageSync(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  buildId: string,
): Promise<PageSync> {
  const syncUrl = syncUrlFrom(env);
  const worker = await buildSyncWorker(root);
  const boot = await buildPageBoot(root);
  return {
    routes: [...syncWorkerRoutes(() => worker), ...pageBootRoutes(() => boot)],
    scripts: [worker, boot].filter((script): script is FrameworkScript => script !== undefined),
    head: {
      syncUrl,
      buildId,
      ...(worker === undefined ? {} : { workerUrl: worker.url }),
      ...(boot === undefined ? {} : { bootUrl: boot.url }),
    },
    persisted: persistedRecordTypes,
  };
}
