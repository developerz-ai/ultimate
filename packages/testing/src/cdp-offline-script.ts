// One responsibility: `navigator.onLine` reads `false` from a document's FIRST script while the
// session's offline switch is thrown, and reads `true` again — with the `online` event a page
// reconnects on — when it goes back. `Network.emulateNetworkConditions` cuts the NETWORK for a
// document created under the switch but, measured on Chrome 150, never tells it so: a reload under
// the switch read `navigator.onLine === true` at its first script every time, COOP or not, still
// read `true` a second later, and got no `online` event when the switch went back.
// `Network.overrideNetworkState` changed nothing. The dummy's page boot asks at its first script
// and replayed its outbox with a real POST under the cut (`offline-like.e2e.test.ts`, two attempts).
//
// The override is an OWN property on `navigator`, so the real getter on `Navigator.prototype` is one
// `delete` away. A document Chrome DID tell (it saw `offline`) gets Chrome's own `online` event on
// restore; one it never told gets one from `RESTORE_ONLINE`, so a page reconnects exactly once.

import type { CdpResult } from './cdp-connection';

type Send = (
  method: string,
  params: Record<string, unknown>,
  session: string,
) => Promise<CdpResult>;

/** Runs before the page's own scripts, in every document a page session creates while cut. */
export const OFFLINE_FIRST_SCRIPT = `(() => {
  let told = false;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  addEventListener('offline', () => { told = true; });
  addEventListener('online', () => { delete navigator.onLine; }, { once: true });
  Object.defineProperty(window, '__xRestoreOnLine', { configurable: true, value: () => {
    if (!Object.getOwnPropertyDescriptor(navigator, 'onLine')) return;
    delete navigator.onLine;
    if (!told) dispatchEvent(new Event('online'));
  } });
})();`;

/** Evaluated in every open page when the switch goes back: a no-op in a document never cut. */
export const RESTORE_ONLINE = `window.__xRestoreOnLine?.()`;

export interface OfflineScripts {
  /** Register the script on one page session, once; answers once the browser has it. */
  add(session: string): Promise<unknown>;
  /** Unregister it from one page session, if it holds it, and restore the open document. */
  remove(session: string): Promise<unknown>;
}

const field = (from: unknown, key: string): string | undefined => {
  const value =
    typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

/** Per-session registration, keyed by the identifier the browser hands back. */
export function offlineScripts(send: Send): OfflineScripts {
  const held = new Map<string, string>();
  return {
    async add(session) {
      // Held already: a second `offline(true)` registered a second copy and kept one id, so
      // `online()` removed one and every new page still read `navigator.onLine === false`.
      if (held.has(session)) return undefined;
      const answer = await send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: OFFLINE_FIRST_SCRIPT },
        session,
      );
      const identifier = field(answer.result, 'identifier');
      if (identifier !== undefined) held.set(session, identifier);
      return answer;
    },
    async remove(session) {
      const identifier = held.get(session);
      if (identifier === undefined) return undefined;
      held.delete(session);
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, session);
      return send('Runtime.evaluate', { expression: RESTORE_ONLINE }, session);
    },
  };
}
