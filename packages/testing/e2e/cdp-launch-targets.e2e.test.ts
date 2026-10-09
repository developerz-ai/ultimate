// A launched browser runs the page it was handed and nothing else. Google Chrome's component
// extensions survive `--disable-extensions`, each with a page of its own, and one of them loading
// `thunk.js` at start-up was paused by `x shot`'s browser-wide interception and logged as the page's
// off-list request (CI, 2026-10-09). Skips with no Chrome, and refuses to skip under
// `E2E_BROWSER_REQUIRED=1`.

import { describe, expect, test } from 'bun:test';
import { E2E_BROWSER_OPEN_MS } from '../src/cdp-browser';
import { findChrome, launchChrome } from '../src/cdp-launch';

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';

interface TargetInfo {
  readonly type: string;
  readonly url: string;
}

const isTargetInfo = (value: unknown): value is TargetInfo =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string' &&
  typeof (value as { url?: unknown }).url === 'string';

describe.skipIf(chrome === undefined && !required)('launchChrome — the browser it starts', () => {
  test(
    'runs no extension page or worker beside the page it was handed',
    async () => {
      if (chrome === undefined)
        expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
      const browser = await launchChrome({ executable: chrome, timeoutMs: 20_000 });
      try {
        const answer = await browser.connection.send('Target.getTargets');
        const infos = (answer.result as { targetInfos?: unknown } | undefined)?.targetInfos;
        const targets = (Array.isArray(infos) ? infos : []).filter(isTargetInfo);
        expect(targets.map((target) => `${target.type} ${target.url}`)).toEqual([
          'page about:blank',
        ]);
      } finally {
        await browser.close();
      }
    },
    E2E_BROWSER_OPEN_MS,
  );
});
