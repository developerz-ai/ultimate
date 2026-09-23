/**
 * "A new version is live." — in the BROWSER, which is the only place it can be true. Version skew
 * is a signal, not a 404: the reader reloads when they choose to, and nothing is thrown away.
 *
 * It was a server component guarded on `hasPageSocket()`, which is always `false` on a server
 * render, so the banner rendered nothing, shipped no module and could never appear.
 *
 * This island listens to the SERVICE WORKER: `AppUpdateAvailable` (`@ultimat3/pwa`'s
 * `version-skew.ts`), posted to every page it controls on activation and on a skewed answer, and
 * compared against this document's own build meta so the worker announcing the build this page
 * already runs says nothing. The sync node's announcement is the page's SOCKET, and reading it
 * costs `useConnection()` — the socket host, ~77 kB in a chunk of its own under `splitting: false`
 * — so it is read where a live island already holds the socket (`feed.island.tsx`,
 * `like.island.tsx`), never opened here for a banner.
 *
 * Plain DOM, no `solid-js`: every `app/` page carries this chunk.
 */

import { APP_UPDATE_MESSAGE, CLIENT_BUILD_META } from '@ultimat3/core/page';

export interface UpdateBannerProps {
  /** Already translated: an island's props cross as JSON, so `t()` cannot travel. */
  readonly label: string;
  readonly action: string;
}

/** The build a worker message announces, when it is one this document is not running. */
export function announcedBuild(data: unknown, running: string | null): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { readonly type?: unknown; readonly to?: unknown };
  if (message.type !== APP_UPDATE_MESSAGE || typeof message.to !== 'string') return null;
  return message.to === running ? null : message.to;
}

export function mount(el: HTMLElement, props: UpdateBannerProps): void {
  const running =
    document.querySelector(`meta[name="${CLIENT_BUILD_META}"]`)?.getAttribute('content') ?? null;
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    if (announcedBuild(event.data, running) === null || el.childElementCount > 0) return;
    const banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.dataset['role'] = 'update-available';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = props.action;
    reload.addEventListener('click', () => location.reload());
    banner.append(`${props.label} `, reload);
    el.append(banner);
  });
}
