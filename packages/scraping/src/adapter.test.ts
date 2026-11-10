// The installer reachable from `@ultimat3/scraping/adapter` and from nowhere else, so
// `scrapeDriver` in `apps/<app>/runtime.ts` stays the one way an app chooses a browser.

import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import * as barrel from './index';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

describe('@ultimat3/scraping/adapter', () => {
  test('package.json maps ./adapter to this file', () => {
    expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  });

  test('carries the installer and the errors a driver throws', () => {
    expect(typeof adapter.installScrapeDriver).toBe('function');
    expect(typeof adapter.resetScrapeDriver).toBe('function');
    expect(typeof adapter.browserUnreachable).toBe('function');
    expect(typeof adapter.ScrapeError).toBe('function');
  });

  test('the `.` barrel leaves the driver-author surface to this entry', () => {
    const names = Object.keys(barrel);
    for (const gone of ['cdpAttachFailed', 'parseRobots', 'runRecovery']) {
      expect(names).not.toContain(gone);
    }
  });

  // A session store is no port (no `runtime.ts` field takes one): the in-memory one an app passes
  // to a scrape stays on `.`, and only there.
  test('memorySessionStore is on `.` alone', () => {
    expect(Object.keys(barrel)).toContain('memorySessionStore');
    expect(Object.keys(adapter)).not.toContain('memorySessionStore');
  });

  test('the `.` barrel carries no installer and no clock of its own (core owns the clock)', () => {
    const names = Object.keys(barrel);
    for (const gone of [
      'setScrapeDriver',
      'installScrapeDriver',
      'resetScrapeDriver',
      'setScrapeClock',
      'resetScrapeClock',
      'scrapeClock',
      'systemScrapeClock',
      'testScrapeClock',
      'noWaitClock',
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});
