// Which islands one build bundles together: those every route renders together, and no other. The
// partition is pure (`groupIslands`); the reading of route files (`routeIslandReferences`) is
// against real files, because what it must ignore — comments, a path no island is at — is on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete, and a fixture root may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { groupIslands, islandGroups, routeIslandReferences } from './island-groups';
import { processRoot } from './process-root-fixture';

const LIKE = 'apps/web/app/posts/[id]/like.island.tsx';
const BADGE = 'apps/web/app/posts/[id]/likes-badge.island.tsx';
const SUMMARY = 'apps/web/app/posts/[id]/summary.island.tsx';
const BANNER = 'apps/web/app/update-banner.island.tsx';
const FEED = 'apps/web/app/feed/feed.island.tsx';
const CONTACT = 'apps/web/site/pricing/contact-sales.island.tsx';
const POST = 'apps/web/app/posts/[id]/page.tsx';
const FEED_PAGE = 'apps/web/app/feed/page.tsx';
const PRICING = 'apps/web/site/pricing/page.tsx';

/** The reference app's shape: one route renders three islands, every app/ route the banner. */
const REFERENCES = new Map<string, ReadonlySet<string>>([
  [POST, new Set([LIKE, BADGE, SUMMARY, BANNER])],
  [FEED_PAGE, new Set([FEED, BANNER])],
  [PRICING, new Set([CONTACT])],
]);
const ISLANDS = [BANNER, CONTACT, FEED, LIKE, BADGE, SUMMARY].sort();

describe('groupIslands', () => {
  test('islands rendered on exactly the same routes are one group; every other island is alone', () => {
    expect(groupIslands(ISLANDS, REFERENCES)).toEqual([
      [LIKE, BADGE, SUMMARY].sort(),
      [FEED],
      [BANNER],
      [CONTACT],
    ]);
  });

  test('an island every route shares (the banner) never joins a group, so no route pays for it', () => {
    const groups = groupIslands(ISLANDS, REFERENCES);
    expect(groups.find((group) => group.includes(BANNER))).toEqual([BANNER]);
  });

  test('one more route rendering ONE member alone splits the group: that route must not pay more', () => {
    const references = new Map(REFERENCES);
    references.set('apps/web/app/likes/page.tsx', new Set([LIKE]));
    const groups = groupIslands(ISLANDS, references);
    expect(groups).toContainEqual([LIKE]);
    expect(groups).toContainEqual([BADGE, SUMMARY].sort());
  });

  test('an island no route names is built alone, and every island lands in exactly one group', () => {
    const orphan = 'apps/web/shared/orphan.island.tsx';
    const groups = groupIslands([...ISLANDS, orphan].sort(), REFERENCES);
    expect(groups).toContainEqual([orphan]);
    expect(groups.flat().sort()).toEqual([...ISLANDS, orphan].sort());
  });

  test('the partition does not depend on the order the routes were read in', () => {
    const reversed = new Map([...REFERENCES].reverse());
    expect(groupIslands([...ISLANDS].reverse(), reversed)).toEqual(
      groupIslands(ISLANDS, REFERENCES),
    );
  });
});

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'groups'));
const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);
const MOUNT = 'export function mount(): void {}\n';

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const file of [LIKE, BADGE, SUMMARY, BANNER, FEED]) await write(file, MOUNT);
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('routeIslandReferences', () => {
  test('reads every island a page declares, resolved from the page, comments and ghosts ignored', async () => {
    await write(
      POST,
      `import { island } from '@ultimat3/render';
// The './feed.island.tsx' this comment names is not rendered here.
/* nor \`../../feed/feed.island.tsx\` */
const Like = island({ src: './like.island.tsx' });
const Badge = island({ src: "./likes-badge.island.tsx", props: ['n'] });
const Summary = island({ src: \`./summary.island.tsx\` });
const Ghost = island({ src: './ghost.island.tsx' });
const Banner = updateBannerIsland('../../update-banner.island.tsx');
export default function Page() { return <main><Like /><Badge n={1} /><Summary /><Ghost /><Banner /></main>; }
`,
    );
    await write(FEED_PAGE, `const Feed = island({ src: './feed.island.tsx' });\n`);
    await write('apps/web/app/plain/page.tsx', 'export const nothing = 1;\n');
    const islands = new Set([LIKE, BADGE, SUMMARY, BANNER, FEED]);

    const references = await routeIslandReferences(ROOT, islands);
    expect(references.get(POST)).toEqual(new Set([LIKE, BADGE, SUMMARY, BANNER]));
    expect(references.get(FEED_PAGE)).toEqual(new Set([FEED]));
    expect(references.has('apps/web/app/plain/page.tsx')).toBe(false);
  });

  test('a page that does not parse is read as written rather than failing the build', async () => {
    await write(POST, `const Like = island({ src: './like.island.tsx' }); <<<\n`);
    const references = await routeIslandReferences(ROOT, new Set([LIKE]));
    expect(references.get(POST)).toEqual(new Set([LIKE]));
  });

  test('islandGroups reads the app and partitions it in one call', async () => {
    await write(
      POST,
      `island({ src: './like.island.tsx' }); island({ src: './likes-badge.island.tsx' });\n`,
    );
    await write(FEED_PAGE, `island({ src: './feed.island.tsx' });\n`);
    expect(await islandGroups(ROOT, [BADGE, FEED, LIKE])).toEqual([[LIKE, BADGE].sort(), [FEED]]);
  });
});
