// `--shape offline`'s browser proofs, both against the built app with the network cut by the e2e
// driver's `offline()` (which cuts the service worker's network too): the offline document answers
// a page the cache cannot, and a post written offline is queued, then sent once on reconnect.

import type { GeneratedFile, NameSet } from '../naming';

export const FALLBACK_E2E = 'apps/web/site/offline/page.e2e.test.ts';
export const WRITE_E2E = 'apps/web/app/posts/offline-write.e2e.test.ts';

const fallback = (
  app: NameSet,
): string => `// The offline fallback in a real browser, with the network CUT — what \`page.test.ts\` cannot see:
// that the service worker installed, precached this document, and answers a navigation with it
// when neither the network nor the cache has the page. Its own file because the gate types a test
// by its FILENAME — an e2eTest in page.test.ts is a unit test.
import { useT } from '@${app.kebab}/i18n';
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest(
  'with the network cut, a page no cache holds is answered by the offline document',
  async ({ page, offline, online }) => {
    const t = useT();
    // One browser serves the whole run, and a suite before this one may have left it offline.
    await online();
    await page.goto('/');
    // The worker must control the page before the cut, or nothing is there to answer.
    await page.waitForServiceWorker();
    await offline();
    try {
      // \`/posts\` is personal (a policy, \`stream\`): never cached, so offline it is the fallback.
      await page.goto('/posts');
      expect(await page.title()).toContain(t('app.offline.title'));
      // And the fallback itself is precached, so it answers by its own URL too.
      await page.goto('/offline');
      expect(await page.title()).toContain(t('app.offline.title'));
    } finally {
      await online();
    }
  },
);
`;

const write =
  (): string => `// A post written with the network CUT, in a real browser: the form takes it, realtime's outbox
// holds it in IndexedDB, and on reconnect it is sent — once, under its idempotency key — so the
// list shows it exactly one time. Its own file because the gate types a test by its FILENAME.
import { e2eTest, expect, type PageLike } from '@ultimat3/testing';

const TITLE = 'Written in a tunnel';

/**
 * Asks \`probe\` until it holds, ~20 s at most. Counted in turns, never read off \`Date.now()\`: the
 * test preload freezes the clock, so a deadline computed from it never arrives.
 */
async function until(what: string, probe: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (await probe()) return;
    await Bun.sleep(100);
  }
  expect({ waitedFor: what, held: await probe() }).toEqual({ waitedFor: what, held: true });
}

/** How many writes the form says are queued on this device — the outbox's live size. */
const queued = (page: PageLike): Promise<string | null> =>
  page.evaluate(
    () =>
      document.querySelector('[data-x-island] [data-role="status"]')?.getAttribute('data-queued') ??
      null,
  );

e2eTest(
  'a post written offline is queued on the device, and sent once the network returns',
  async ({ page, offline, online }) => {
    // One browser serves the whole run, and a suite before this one may have left it offline.
    await online();
    await page.goto('/posts');
    await page.waitForServiceWorker();
    // Mounted, and the page boot has opened the outbox: the status line reports its size.
    await until('the form to mount', async () => (await queued(page)) === '0');

    await offline();
    try {
      await page.evaluate(() => {
        const [title, price] = Array.from(
          document.querySelectorAll<HTMLInputElement>('[data-x-island] form input'),
        );
        if (title === undefined || price === undefined) return false;
        title.value = 'Written in a tunnel';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        price.value = '3.50';
        price.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector<HTMLButtonElement>('[data-x-island] form button')?.click();
        return true;
      });
      // On disk, not in memory: the outbox is IndexedDB, so a reload or a closed tab keeps it.
      await until('the write to queue', async () => (await queued(page)) === '1');
    } finally {
      await online();
    }

    // Back online, the outbox replays by itself — no reload, no second submit.
    await until('the replay', async () => (await queued(page)) === '0');
    await page.reload();
    // Sent ONCE: the replay carried the write's own key, so the list holds one row, not two.
    const rows = (): Promise<number> =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll('tr[data-row]')).filter((row) =>
            row.textContent?.includes('Written in a tunnel'),
          ).length,
      );
    await until('the row to list', async () => (await rows()) > 0);
    const shown = await rows();
    expect({ title: TITLE, shown }).toEqual({ title: TITLE, shown: 1 });
  },
);
`;

/** Both suites: the fallback beside the page it proves, the write beside the list it lands in. */
export const offlineE2eFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: FALLBACK_E2E, contents: fallback(app) },
  { path: WRITE_E2E, contents: write() },
];
