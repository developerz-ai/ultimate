// `x g resource`'s list page, read by Postgres: the generated test that renders the same sorted,
// paged list as `page.test.ts` with the app's migrated database installed under the handle.

import { sortedImports } from './imports';
import type { ResourcePageOptions } from './resource-page';

/** The org the rows belong to — the same one `page.test.ts` writes under. */
const ORG = '00000000-0000-4000-8000-000000000002';

/**
 * The same sort and the same pages, read by Postgres: the app's migrated database installed under
 * the handle, so the query's SQL — `order by`, the keyset seek — answers instead of the memory
 * thunk. The database is embedded Postgres (PGlite) booted from the migrated template, so the
 * proof needs no server and runs on the `unit` step.
 */
export const pageDbTest = (options: ResourcePageOptions): string => {
  const { feature } = options;
  const path = feature.pluralKebab;
  return `// /${path} against the app's migrated database: the read's SQL path, where page.test.ts is the
// in-memory one. The same rows, sorted and paged by link, come back in the same order.
${sortedImports([
  "import { migratedDatabase } from '@ultimat3/cli';",
  "import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';",
  "import { setDbClient } from '@ultimat3/db';",
  "import { testActor } from '@ultimat3/policy';",
  "import {\n  afterAll,\n  beforeAll,\n  expect,\n  renderRoute,\n  reusableDatabase,\n  unitTest,\n} from '@ultimat3/testing';",
])}
// The app's API, as boot loads it: \`defineApi\` names the query the page reads.
import '../../api';
import * as repo from '../${feature.kebab}/repo';
import * as page from './page';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));
beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
// Back to memory, so this file's database never reaches the next file's unit tests.
afterAll(() => setDbClient(undefined));

const url = 'https://example.test/${path}';
const orgId = '${ORG}';
// The read grant, named once so the line below fits the formatter's width at any feature name.
const read = '${feature.kebab}:read';
const member = testActor('member', { orgId, permissions: [read] }).actor;
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (title: string) => {
  const draft = { orgId, title, price: { minor: 1200, currency: 'USD' } };
  return runWithContext(ctxOf({ actor: member, clock }), () => repo.insert(draft));
};

/** The anchor a pager side renders, read off the HTML: \`rel\` names the side. */
const linkTo = (html: string, rel: string): string | undefined => {
  const anchor = new RegExp(\`<a\\\\b[^>]*\\\\brel="\${rel}"[^>]*>\`).exec(html)?.[0];
  return /href="([^"]*)"/.exec(anchor ?? '')?.[1]?.replaceAll('&amp;', '&');
};

unitTest('Postgres sorts and pages the list as the memory read does', async () => {
  for (const title of ['beta', 'gamma', 'alpha']) {
    await store(title);
    clock.advance(1000);
  }
  // Unsorted is the query's own order, newest first.
  const newest = await renderRoute(page, { url, actor: member });
  expect(newest.text.indexOf('alpha')).toBeLessThan(newest.text.indexOf('gamma'));
  expect(newest.text.indexOf('gamma')).toBeLessThan(newest.text.indexOf('beta'));

  // By title, two to a page: the first two titles, then the third through the cursor.
  const sorted = \`\${url}?sort=title&dir=asc&limit=2\`;
  const first = await renderRoute(page, { url: sorted, actor: member });
  expect(first.text.indexOf('alpha')).toBeLessThan(first.text.indexOf('beta'));
  expect(first.text).not.toContain('gamma');
  const next = linkTo(first.html, 'next');
  const second = await renderRoute(page, { url: new URL(next ?? '', url).href, actor: member });
  expect(second.text).toContain('gamma');
  expect(second.text).not.toContain('alpha');
  expect(linkTo(second.html, 'next')).toBeUndefined();
});
`;
};
