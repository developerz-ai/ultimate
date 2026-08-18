// The HTTP leg, offline — the second half of the ONE fixture format. A hybrid scrape replays end
// to end from a single directory: browser login, session handoff, HTTP bulk fetch.
//
// Same rule as the page half: an unrecorded request THROWS. A transport that fell through to the
// real network would make the hybrid path — which is where the interesting code lives — the one
// path a test never really covers.

import type { ScrapeClock } from './clock';
import { fixtureMissing, fixtureStale, hostBlocked } from './error-throws';
import type { HttpRequestInit, ScrapeHttp, ScrapeResponse } from './http';
import { responseOver } from './http';
import type { InterceptRules } from './intercept';
import { interceptVerdict } from './intercept';
import type { HttpRecording } from './recording';
import type { NetworkRing } from './rings';

export type HttpRecordingLookup = (
  method: string,
  url: string,
) => Promise<HttpRecording | undefined>;

export interface RecordedHttpInit {
  readonly lookup: HttpRecordingLookup;
  readonly rules: InterceptRules;
  readonly network: NetworkRing;
  readonly clock: ScrapeClock;
  readonly source: string;
  readonly maxAgeMs?: number | undefined;
}

/** `GET https://api.example.com/v1/orders?page=2` -> `http-get-api-example-com-v1-orders-page-2`. */
export function httpRecordingFilename(method: string, url: string): string {
  const slug = `${method}-${url.replace(/^[a-z]+:\/\//i, '')}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `http-${slug}.json`;
}

export function recordedHttp(init: RecordedHttpInit): ScrapeHttp {
  return {
    async request(url: string, request: HttpRequestInit = {}): Promise<ScrapeResponse> {
      const method = (request.method ?? 'GET').toUpperCase();
      // The host rule applies to the offline leg too. Otherwise a scrape that a fixture proves
      // correct would be the first thing to hit a host `allowHosts` forbids, in production.
      if (interceptVerdict(url, 'fetch', init.rules) !== 'allow') {
        throw hostBlocked(url, init.rules.allowHosts);
      }
      const found = await init.lookup(method, url);
      if (found === undefined) throw fixtureMissing(`${method} ${url}`, init.source);
      if (init.maxAgeMs !== undefined && found.recordedAt !== undefined) {
        const age = init.clock.now().getTime() - new Date(found.recordedAt).getTime();
        if (age > init.maxAgeMs) throw fixtureStale(`${method} ${url}`, age, init.maxAgeMs);
      }
      init.network.push({
        method,
        url,
        status: found.status,
        resourceType: 'fetch',
        at: init.clock.now().getTime(),
      });
      return responseOver(url, found.status, found.headers ?? {}, () =>
        Promise.resolve(found.body),
      );
    },
  };
}

/** In-memory recordings, keyed `METHOD url`. What `fakeBrowser({ http })` is built from. */
export function httpRecordingsOf(recordings: readonly HttpRecording[]): Map<string, HttpRecording> {
  return new Map(
    recordings.map((recording) => [
      `${recording.method.toUpperCase()} ${recording.url}`,
      recording,
    ]),
  );
}
