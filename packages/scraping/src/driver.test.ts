// The ambient driver slot is PROCESS state, so its test is also the demonstration that a test can
// put the process back: `bun test` runs many files in one process, and a driver installed here and
// left behind is a driver every later file runs against without asking for one.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ScrapeDriver, ScrapeSession } from './driver';
import { installScrapeDriver, resetScrapeDriver, scrapeDriver } from './driver';

const named = (name: string): ScrapeDriver => ({
  name,
  open: () =>
    Promise.reject(
      new Error('this driver is a marker; nothing opens it'),
    ) as Promise<ScrapeSession>,
});

// Belt and braces: every test below resets, and so does this — the leak this file exists to
// prevent must not be able to escape from the file that describes it.
afterEach(resetScrapeDriver);

describe('unit · the ambient driver is installed, read back and given back', () => {
  test('nothing is installed until something installs it', () => {
    expect(scrapeDriver()).toBeUndefined();
  });

  test('the installer installs THAT object — the accessor is not a name lookup', () => {
    const local = named('puppeteer');
    installScrapeDriver(local);
    expect(scrapeDriver()).toBe(local);
  });

  test('the last install wins, so a boot may replace a driver a test installed', () => {
    installScrapeDriver(named('fixture'));
    installScrapeDriver(named('fake'));
    expect(scrapeDriver()?.name).toBe('fake');
  });

  test('reset puts the slot back to EMPTY, not to some default driver', () => {
    // `scrape-run.test.ts` asserts X_SCRAPE_DRIVER_UNKNOWN after calling this, and that assertion
    // is only reachable while the answer here is `undefined` — a reset that installed a fallback
    // would turn that whole failure mode into a test nobody can write.
    installScrapeDriver(named('puppeteer'));
    resetScrapeDriver();
    expect(scrapeDriver()).toBeUndefined();
  });

  test('the installer answers its release, which puts back exactly what it replaced', () => {
    const first = named('fixture');
    installScrapeDriver(first);
    const release = installScrapeDriver(named('fake'));
    release();
    expect(scrapeDriver()).toBe(first);
    // Twice is still once: a second release does not reach further back, even past a later install.
    installScrapeDriver(named('later'));
    release();
    expect(scrapeDriver()?.name).toBe('later');
  });

  test('releases out of order: the earlier release leaves the later install standing', () => {
    const releaseA = installScrapeDriver(named('a'));
    const releaseB = installScrapeDriver(named('b'));
    releaseA();
    expect(scrapeDriver()?.name).toBe('b');
    releaseB();
    expect(scrapeDriver()).toBeUndefined();
  });

  test('reset is idempotent — a second one is not an error', () => {
    resetScrapeDriver();
    resetScrapeDriver();
    expect(scrapeDriver()).toBeUndefined();
  });
});
