// One assembly for both offline drivers: the recorded page target, the recorded HTTP transport
// and the page vocabulary over them. `fakeBrowser()` and `fixtureBrowser()` differ only in where
// the recordings come from — and a second copy of this wiring is how the two would drift apart on
// the day one of them learns about sessions and the other does not.

import type { ScrapeSession, SessionInit } from './driver';
import type { RecordingLookup } from './html-target';
import { htmlTarget } from './html-target';
import type { HttpRecordingLookup } from './http-recorded';
import { recordedHttp } from './http-recorded';
import { pageOverTarget } from './page-over-target';
import type { PageRecording } from './recording';
import type { SessionSnapshot } from './session-state';
import type { ScrapeCookie } from './target';

export interface OfflineSessionInit {
  readonly driver: string;
  readonly source: string;
  readonly lookup: RecordingLookup;
  readonly http: HttpRecordingLookup;
  readonly session: SessionInit;
  readonly start?: PageRecording | undefined;
  readonly maxAgeMs?: number | undefined;
  readonly cookies?: readonly ScrapeCookie[] | undefined;
  readonly snapshot?: SessionSnapshot | undefined;
}

export async function openOfflineSession(init: OfflineSessionInit): Promise<ScrapeSession> {
  const target = htmlTarget({
    driver: init.driver,
    lookup: init.lookup,
    rules: init.session.rules,
    clock: init.session.clock,
    source: init.source,
    start: init.start,
    maxAgeMs: init.maxAgeMs,
    cookies: init.cookies,
    session: init.snapshot,
  });
  // Restored BEFORE the first navigation, exactly as a real driver must: a session put back after
  // the first request is a first request made logged out.
  if (init.session.restore !== undefined) await target.restore(init.session.restore);
  return {
    driver: init.driver,
    page: pageOverTarget(target, {
      clock: init.session.clock,
      allowHosts: init.session.rules.allowHosts,
      defaultTimeoutMs: init.session.timeoutMs,
      secrets: init.session.secrets,
      robots: init.session.robots,
      signal: init.session.signal,
      onActivity: init.session.onActivity,
      pace: init.session.pace,
    }),
    http: recordedHttp({
      lookup: init.http,
      rules: init.session.rules,
      network: target.network,
      clock: init.session.clock,
      source: init.source,
      // The same gate the page above holds, from the same field: two legs, one robots decision.
      robots: init.session.robots,
      // The same bag, for the same reason: a redaction only the live leg performs is one no
      // fixture can prove.
      secrets: init.session.secrets,
      maxAgeMs: init.maxAgeMs,
    }),
    close: () => target.close(),
  };
}
