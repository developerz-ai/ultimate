// Recorded pages AND recorded HTTP on disk, replayed from ONE directory. The difference from
// `fakeBrowser()` is only where the recordings live — and the difference from a live driver is
// that this one CANNOT reach the network: a request with no file under `dir` is
// `X_SCRAPE_FIXTURE_MISSING`, never a fetch.
//
// One directory for both legs is the point. A hybrid scrape — browser login, session handoff,
// HTTP bulk fetch — replays end to end, so the part of a scraper that is hardest to get right is
// not the part that has no test.
//
// Recordings age. A fixture recorded eighteen months ago proves that a scraper still parses a
// page that no longer exists, which is worse than no test at all — hence `maxAge`.

import type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
import { httpRecordingFilename } from './http-recorded';
import { openOfflineSession } from './offline-session';
import type { HttpRecording, PageRecording } from './recording';
import { parseHttpRecording, parseRecording } from './recording';

export const FIXTURE_DRIVER = 'fixture';

/**
 * `https://example.com/a/b?q=1` -> `example.com-a-b-q-1.json`. Deterministic and readable, so the
 * `X_SCRAPE_FIXTURE_MISSING` fix can name the exact file to create and a reviewer can tell which
 * page a recording is without opening it.
 */
export function recordingFilename(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  const slug = withoutScheme
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'index' : slug}.json`;
}

export interface FixtureBrowserOptions {
  /** Milliseconds. A recording older than this refuses the run rather than passing on old HTML. */
  readonly maxAge?: number | undefined;
}

export function fixtureBrowser(dir: string, options: FixtureBrowserOptions = {}): ScrapeDriver {
  const lookup = async (url: string): Promise<PageRecording | undefined> => {
    const file = Bun.file(`${dir}/${recordingFilename(url)}`);
    if (!(await file.exists())) return undefined;
    // Parsed, never cast: a recording is an edited file on somebody's disk, so it is `unknown`
    // until a schema says otherwise.
    return parseRecording(await file.json());
  };
  const http = async (method: string, url: string): Promise<HttpRecording | undefined> => {
    const file = Bun.file(`${dir}/${httpRecordingFilename(method, url)}`);
    if (!(await file.exists())) return undefined;
    return parseHttpRecording(await file.json());
  };
  return {
    name: FIXTURE_DRIVER,
    open: (session: SessionInit): Promise<ScrapeSession> =>
      openOfflineSession({
        driver: FIXTURE_DRIVER,
        source: dir,
        lookup,
        http,
        session,
        maxAgeMs: options.maxAge,
      }),
  };
}
