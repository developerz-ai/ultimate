// A frame's accessibility read, scoped to the FRAME's document: the root `cdp-a11y-frame.ts` finds
// through the page's own session, twins told apart by place, and a cross-site frame under site
// isolation refused by name — the protocol sequence measured on Chrome 157 (2026-11-15).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { frameDocument } from './cdp-a11y-frame';
import { fakeCdpBrowser } from './cdp-fake-fixture';
import type { CdpSessionLike } from './cdp-port';
import { cdpTarget } from './cdp-target';

const PARENT = '<input id="user"><iframe name="idp"></iframe>';
const BUTTON = [{ role: 'button', name: 'Sign in', ignored: false }] as const;

const open = async (outOfProcess = false) => {
  const browser = fakeCdpBrowser({
    url: 'https://shop.test/login',
    html: PARENT,
    accessibility: { '#go': [{ role: 'link', name: 'Parent', ignored: false }] },
    frames: {
      idp: {
        url: 'https://idp.test/frame',
        html: '<button id="go">Sign in</button>',
        accessibility: { '#go': BUTTON },
        outOfProcess,
      },
    },
  });
  const target = await cdpTarget({
    browser,
    page: await browser.newPage(),
    rules: { allowHosts: ['shop.test', 'idp.test'] },
    clock: frozenClock(),
  });
  const frame = (await target.frames())[0]?.target;
  if (frame === undefined) throw expect.unreachable('the fake answered no frame');
  return { browser, target, frame };
};

describe('unit · a frame reads its own accessibility tree', () => {
  test("the frame's nodes, never the parent's same-id element", async () => {
    const { browser, target, frame } = await open();
    expect(await frame.accessibility('#go', 5)).toEqual(BUTTON);
    expect(await target.accessibility('#go', 5)).toEqual([
      { role: 'link', name: 'Parent', ignored: false },
    ]);
    expect(browser.sessions.detached).toBe(browser.sessions.created);
  });

  test('a frame in another process is X_SCRAPE_FRAME_OUT_OF_PROCESS, terminal, through guard()', async () => {
    const { browser, frame } = await open(true);
    let thrown: { code?: string; retry?: string; fix?: string } = {};
    await frame.accessibility('#go', 5).catch((caught: unknown) => {
      thrown = caught as typeof thrown;
    });
    expect(thrown.code).toBe('X_SCRAPE_FRAME_OUT_OF_PROCESS');
    expect(thrown.retry).toBe('terminal');
    expect(thrown.fix).toContain('--disable-site-isolation-trials');
    // The refusal path detaches the session too.
    expect(browser.sessions.detached).toBe(browser.sessions.created);
  });
});

describe('unit · twins — same name, same URL — are told apart by place', () => {
  test('the ordinal picks the second twin, and its owner is the one asked', async () => {
    const asked: unknown[] = [];
    const twin = (id: string) => ({ frame: { id, name: 'ad', url: 'https://ads.test/' } });
    const session: CdpSessionLike = {
      send: (method, params) => {
        asked.push([method, params]);
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main', url: 'https://shop.test/' },
              childFrames: [twin('a'), twin('b')],
            },
          });
        }
        if (method === 'DOM.getFrameOwner') return Promise.resolve({ backendNodeId: 40 });
        if (method === 'DOM.describeNode') {
          return Promise.resolve({ node: { contentDocument: { backendNodeId: 41 } } });
        }
        return Promise.resolve({ nodeIds: [77] });
      },
      detach: () => Promise.resolve(),
    };
    const root = await frameDocument('puppeteer', {
      name: 'ad',
      url: 'https://ads.test/',
      ordinal: 1,
    })(session, 1);
    expect(root).toBe(77);
    expect(asked).toContainEqual(['DOM.getFrameOwner', { frameId: 'b' }]);
  });
});
