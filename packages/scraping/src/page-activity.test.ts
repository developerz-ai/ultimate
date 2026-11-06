// Every browser verb is activity the wedge watchdog must see. `cookies`, `session`, `screenshot`
// and `pdf` reported nothing, so a minutes-long capture or warm-up read as a dead browser — and an
// app's own CDP channel had no way to report at all, until `page.activity()`.

import { describe, expect, test } from 'bun:test';
import { fakePage } from './driver-fake';
import type { ScrapePage } from './page';

const counted = (): { readonly page: ScrapePage; readonly touches: () => number } => {
  let touches = 0;
  const page = fakePage('<p id="a">hi</p>', {
    context: {
      onActivity: () => {
        touches += 1;
      },
    },
  });
  return { page, touches: () => touches };
};

/**
 * Each verb that reaches the browser, called once. A verb the offline target refuses (`evaluate`,
 * `offline`, `download`) still asked the browser, and asking is the activity being measured.
 */
const VERBS: Readonly<Record<string, (page: ScrapePage) => Promise<unknown> | unknown>> = {
  goto: (page) => page.goto('https://fake.test/'),
  evaluate: (page) => page.evaluate('1'),
  html: (page) => page.html(),
  query: (page) => page.query('#a'),
  cookies: (page) => page.cookies(),
  session: (page) => page.session(),
  screenshot: (page) => page.screenshot(),
  pdf: (page) => page.pdf(),
  colorScheme: (page) => page.colorScheme('dark'),
  prepare: (page) => page.prepare('1'),
  offline: (page) => page.offline(true),
  download: (page) => page.download({ timeout: 1 }),
  activity: (page) => page.activity(),
};

describe('unit · every verb adds exactly one touch', () => {
  for (const [name, call] of Object.entries(VERBS)) {
    test(name, async () => {
      const { page, touches } = counted();
      await Promise.resolve()
        .then(() => call(page))
        .catch(() => undefined);
      expect(touches()).toBe(1);
    });
  }

  test('the ring reads are local, and report nothing', () => {
    const { page, touches } = counted();
    page.console();
    page.network();
    page.pageErrors();
    expect(touches()).toBe(0);
  });
});
