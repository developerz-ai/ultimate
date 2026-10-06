// The reveal is asked for by the actionability wait and by nothing else, through the real CDP
// target. `cdp-snapshot.e2e.test.ts` proves in Chrome what the scroll buys (an element below the
// fold is the hit target); this proves which verbs pay for it: every act scrolls its element into
// view before measuring, and a read never moves the page.

import { describe, expect, test } from 'bun:test';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import { pageOverTarget } from './page-over-target';

const SCROLL = 'scrollIntoView';

/** A page whose every snapshot answers one actionable button, and that records each expression. */
const recordingPage = (): { readonly page: CdpPageLike; readonly evaluated: string[] } => {
  const evaluated: string[] = [];
  const button = {
    tag: 'button',
    attrs: { id: 'go' },
    text: 'Go',
    value: '',
    visible: true,
    enabled: true,
    box: { x: 10, y: 10, width: 40, height: 20 },
    hitTarget: true,
  };
  const page: CdpPageLike = {
    url: () => 'https://shop.test/o',
    goto: () => Promise.resolve(undefined),
    content: () => Promise.resolve(''),
    evaluate: (expression: string) => {
      evaluated.push(expression);
      return Promise.resolve(JSON.stringify([button]));
    },
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    focus: () => Promise.resolve(),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () => Promise.resolve(),
    on: () => undefined,
    frames: () => [],
    close: () => Promise.resolve(),
  };
  return { page, evaluated };
};

const pageOver = async (page: CdpPageLike) => {
  const browser: CdpBrowserLike = {
    newPage: () => Promise.resolve(page),
    target: () => fakeBrowserTarget().target,
    close: () => Promise.resolve(),
    process: () => null,
  };
  const target = await cdpTarget({
    page,
    browser,
    rules: { allowHosts: ['shop.test'] },
    clock: testClock(),
  });
  return pageOverTarget(target, {
    clock: testClock(),
    allowHosts: ['shop.test'],
    defaultTimeoutMs: 1_000,
  });
};

describe('unit · the actionability wait scrolls its element into view; a read does not', () => {
  test('click, type, fill, select, focus and waitFor each reveal the element before measuring', async () => {
    const { page, evaluated } = recordingPage();
    const scraped = await pageOver(page);
    const acts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ['click', () => scraped.click('#go')],
      ['type', () => scraped.type('#go', 'x')],
      ['fill', () => scraped.fill('#go', 'x')],
      ['select', () => scraped.select('#go', ['a'])],
      ['focus', () => scraped.focus('#go')],
      ['waitFor', () => scraped.waitFor('#go')],
    ];
    for (const [name, act] of acts) {
      evaluated.length = 0;
      await act();
      const snapshots = evaluated.filter((expression) => expression.includes('querySelectorAll'));
      expect({ name, revealed: snapshots.some((e) => e.includes(SCROLL)) }).toEqual({
        name,
        revealed: true,
      });
    }
  });

  test('text(), count(), query() and a visible-only wait never scroll the page', async () => {
    const { page, evaluated } = recordingPage();
    const scraped = await pageOver(page);
    await scraped.text('#go');
    await scraped.count('#go');
    await scraped.query('#go');
    await scraped.waitFor('#go', { state: 'visible' });
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.filter((expression) => expression.includes(SCROLL))).toEqual([]);
  });
});
