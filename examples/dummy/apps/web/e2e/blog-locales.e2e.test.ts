/**
 * e2e — the public blog is ISR in EVERY locale: publishing a post puts it on `/blog` and on
 * `/es/blog`, and turns the article's stored 404 into the article under both spellings.
 *
 * The prefixed pages are the ones this guards. The router strips `/es` before it matches and the
 * ISR store keeps it, so a lookup that forgot to strip found no route for `/es/blog`: the page
 * joined no tag, and a reader in Spanish kept the blog as it was when the process first rendered it.
 * No browser: the verdict is the served document, exactly as a crawler or a CDN reads it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { seedId } from '@ultimat3/entity';
import type { E2eApp } from '@ultimat3/testing';
import { E2E_APP_START_MS, E2E_APP_STOP_MS } from '@ultimat3/testing';
import { DEMO_MEMBER_COOKIE, fail, startPostly } from './fixtures/postly';

/** The dev seed's one draft (`packages/db/seeds/dev.ts`): bruno's, in acme. */
const DRAFT = {
  id: seedId('post:draft-money'),
  orgId: seedId('org:acme'),
  slug: 'money-is-an-integer',
  title: 'Money is an integer',
} as const;

const INDEXES = ['/blog', '/es/blog'] as const;
const ARTICLES = [`/blog/${DRAFT.slug}`, `/es/blog/${DRAFT.slug}`] as const;
/** How long a stale page may take to be replaced by its regeneration. */
const REGENERATED_MS = 20_000;

describe('the public blog, in every locale', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startPostly();
  }, E2E_APP_START_MS);

  afterAll(async () => {
    await app?.stop();
  }, E2E_APP_STOP_MS);

  const get = (path: string): Promise<Response> => fetch(`${app.base}${path}`);

  /** The page once its regeneration has landed: polled to a deadline, never a fixed wait. */
  async function eventually(
    path: string,
    reached: (status: number, body: string) => boolean,
  ): Promise<{ readonly status: number; readonly body: string }> {
    let seen = { status: 0, body: '' };
    // Counted, never `Date.now()`: the test preload freezes the clock.
    for (let waited = 0; waited < REGENERATED_MS; waited += 50) {
      const response = await get(path);
      seen = { status: response.status, body: await response.text() };
      if (reached(seen.status, seen.body)) break;
      await Bun.sleep(50);
    }
    return seen;
  }

  test(
    'publishing a post reaches the index and the article under the default and the prefixed locale',
    async () => {
      // Rendered BEFORE the write, so each page is a stored entry the publish has to reach — the
      // article's is a stored 404, which is the entry a missed bust keeps longest.
      for (const path of INDEXES) {
        const before = await get(path);
        expect(before.status).toBe(200);
        expect(await before.text()).not.toContain(DRAFT.title);
      }
      for (const path of ARTICLES) expect((await get(path)).status).toBe(404);

      const published = await fetch(`${app.base}/api/posts/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: app.base,
          cookie: `${DEMO_MEMBER_COOKIE}=bruno`,
        },
        body: JSON.stringify({ postId: DRAFT.id, orgId: DRAFT.orgId, notify: false }),
      });
      if (!published.ok) {
        fail(`publishPost answered ${String(published.status)}: ${await published.text()}`);
      }

      for (const path of INDEXES) {
        const after = await eventually(path, (_status, body) => body.includes(DRAFT.title));
        expect({ path, listed: after.body.includes(DRAFT.title) }).toEqual({ path, listed: true });
      }
      for (const path of ARTICLES) {
        const after = await eventually(path, (status) => status === 200);
        expect({ path, status: after.status }).toEqual({ path, status: 200 });
        expect(after.body).toContain(DRAFT.title);
      }
      // Still one document per locale: the prefixed page is the Spanish one.
      expect((await eventually('/es/blog', () => true)).body).toContain('<html lang="es"');
      expect((await eventually('/blog', () => true)).body).toContain('<html lang="en"');
    },
    4 * REGENERATED_MS,
  );
});
