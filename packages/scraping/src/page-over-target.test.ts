// The vocabulary's own traps, on the fake driver — no browser, no port.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { fakeBrowser, fakePage } from './driver-fake';
import type { PageRecording } from './recording';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · frame() re-resolves on every call', () => {
  const PAGES: readonly PageRecording[] = [
    {
      url: 'https://bank.test/step1',
      html: '<iframe name="form" src="/f1"></iframe>',
      frames: { form: '<p id="who">step one</p>' },
    },
    {
      url: 'https://bank.test/step2',
      html: '<iframe name="form" src="/f2"></iframe>',
      frames: { form: '<p id="who">step two</p>' },
    },
  ];

  test('a handle taken before a re-navigation addresses the CURRENT frame, not a detached one', async () => {
    const session = await fakeBrowser(PAGES).open({
      name: 'bank',
      rules: { allowHosts: ['bank.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
    });
    await session.page.goto('https://bank.test/step1');
    // Taken ONCE, before the navigation — the exact shape that goes stale with a locator-style
    // handle, and the single biggest correctness trap in this whole vocabulary.
    const form = session.page.frame('form');
    expect(await form.text('#who')).toBe('step one');
    await session.page.goto('https://bank.test/step2');
    expect(await form.text('#who')).toBe('step two');
    await session.close();
  });

  test('a frame that never appears is X_SCRAPE_SELECTOR_MISSING, not a silent empty read', async () => {
    const page = fakePage('<p>no frames here</p>', { clock: testClock(), timeoutMs: 100 });
    expect(await codeOf(page.frame('missing').text('#x'))).toBe('X_SCRAPE_SELECTOR_MISSING');
  });
});

describe('unit · typing, filling and reading back', () => {
  const FORM =
    '<input id="q" name="q" value="seed"><select id="s"><option value="a">A</option></select>';

  test('type appends to what is there, fill replaces it', async () => {
    const page = fakePage(FORM);
    await page.type('#q', '-more');
    expect((await page.values('#q'))[0]?.value).toBe('seed-more');
    await page.fill('#q', 'fresh');
    expect((await page.values('#q'))[0]?.value).toBe('fresh');
  });

  test('select records the chosen value', async () => {
    const page = fakePage(FORM);
    await page.select('#s', ['a']);
    expect((await page.values('#s'))[0]?.value).toBe('a');
  });

  test('text() with no selector is the whole document', async () => {
    const page = fakePage('<h1>Title</h1><p>Body</p>');
    expect(await page.text()).toBe('TitleBody');
  });
});

describe('unit · interception is recorded, never silent', () => {
  test('a blocked resource type and a foreign host both land in the network ring', async () => {
    const session = await fakeBrowser([
      {
        url: 'https://shop.test/',
        html: '<img src="/logo.png"><img src="https://tracker.test/p.gif"><script src="/a.js"></script>',
      },
    ]).open({
      name: 'shop',
      rules: { allowHosts: ['shop.test'], block: ['image'] },
      clock: testClock(),
      timeoutMs: 1_000,
    });
    await session.page.goto('https://shop.test/');
    const refused = session.page.network().filter((entry) => entry.refused !== undefined);
    expect(refused.map((entry) => [entry.url, entry.refused])).toEqual([
      ['https://shop.test/logo.png', 'blocked'],
      // Blocked BY TYPE before the host is even consulted — the cheaper reason, so an
      // `allowHosts` finding keeps meaning "a host you did not list".
      ['https://tracker.test/p.gif', 'blocked'],
    ]);
    // The script is on an allowed host and is not a blocked type, so it went through.
    expect(session.page.network().some((entry) => entry.url.endsWith('/a.js'))).toBe(true);
    await session.close();
  });
});

describe('unit · the rings are bounded', () => {
  test('a long run keeps the tail, counts the drops, and never grows without limit', async () => {
    const { createRing } = await import('./rings');
    const ring = createRing<number>(3);
    for (let index = 0; index < 10; index += 1) ring.push(index);
    expect(ring.entries()).toEqual([7, 8, 9]);
    expect(ring.dropped).toBe(7);
  });
});
