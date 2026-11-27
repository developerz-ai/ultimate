// Single responsibility: a second browser context on the harness's one browser
// (`Target.createBrowserContext`) — a profile with its own cookies, storage and service workers,
// so two people are signed in at once in one run: an inviter and the invited, an owner and a
// member. Its tabs are the session's own kind: attached, configured and audited as `newTab()`'s.

import type { E2eTab } from './cdp-e2e-page';
import type { E2eSession } from './cdp-e2e-session';
import { sessionPortOf } from './cdp-ports';

export interface E2eContext {
  readonly id: string;
  /** A tab in this context: none of the first profile's cookies or storage. */
  newTab(): Promise<E2eTab>;
  /** Disposes the context and every tab in it. */
  close(): Promise<void>;
}

/** A fresh, isolated profile beside the session's first one. */
export async function newBrowserContext(session: E2eSession): Promise<E2eContext> {
  const port = sessionPortOf(session, 'newBrowserContext');
  const created = await port.connection.send('Target.createBrowserContext', {
    disposeOnDetach: true,
  });
  const raw = created.result?.['browserContextId'];
  const id = typeof raw === 'string' ? raw : '';
  return {
    id,
    newTab: () => port.openTab(id),
    async close() {
      await port.connection.send('Target.disposeBrowserContext', { browserContextId: id });
    },
  };
}
