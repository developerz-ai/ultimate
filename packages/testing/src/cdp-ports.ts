// Single responsibility: the CDP behind a tab or a session the harness built, for the free
// functions that drive a domain neither port names (`WebAuthn`, `Target.createBrowserContext`).
// Kept beside the objects rather than on them: `E2eTab` and `E2eSession` are shapes an app may
// implement, and a member added to either would be a member every hand-rolled one lacks.

import type { CdpConnection } from '@ultimat3/scraping/cdp';
import type { E2eTab } from './cdp-e2e-page';
import type { E2eSession } from './cdp-e2e-session';
import { FixtureUnavailableError } from './errors';

export interface TabPort {
  readonly connection: CdpConnection;
  readonly sessionId: string;
}

export interface SessionPort {
  readonly connection: CdpConnection;
  /** A tab in `browserContextId`'s profile, attached and audited as `newTab()`'s is. */
  openTab(browserContextId: string): Promise<E2eTab>;
}

const tabs = new WeakMap<object, TabPort>();
const sessions = new WeakMap<object, SessionPort>();

export const registerTabPort = (tab: E2eTab, port: TabPort): void => {
  tabs.set(tab, port);
};

export const registerSessionPort = (session: E2eSession, port: SessionPort): void => {
  sessions.set(session, port);
};

/** A tab `cdpE2eTab` built; a hand-rolled one is refused by name, never driven blind. */
export function tabPortOf(tab: E2eTab, what: string): TabPort {
  const port = tabs.get(tab);
  if (port === undefined) {
    throw new FixtureUnavailableError({
      name: what,
      needs: 'a tab cdpE2eTab built — e2eBrowser().page or session.newTab()',
    });
  }
  return port;
}

/** A session `cdpE2eSession` built — `e2eBrowser().session`. */
export function sessionPortOf(session: E2eSession, what: string): SessionPort {
  const port = sessions.get(session);
  if (port === undefined) {
    throw new FixtureUnavailableError({
      name: what,
      needs: 'a session cdpE2eSession built — e2eBrowser().session',
    });
  }
  return port;
}
