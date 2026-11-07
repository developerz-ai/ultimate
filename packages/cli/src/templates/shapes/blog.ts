// `x new <name> --shape blog`: a publication. `site/` is the only rendered surface — an `isr` index
// and one page per post, zero JavaScript on every route — over a `post` slice with no tenant,
// written at `/admin`. No `app/` page, no island, no sign-in page, no dashboard.

import type { GeneratedFile, NameSet } from '../naming';
import { blogSiteFiles } from './blog-site';
import { blogSliceFiles } from './blog-slice';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { claudeRows, shapeLines } from './shared-edits';

const apiIndex = (): string => `/**
 * The API surface: every primitive this app exposes, registered in one call. The site's pages
 * read these two over HTTP through \`shared/client.ts\`; MCP lists both (\`mcp.expose\`).
 */

import { defineApi } from '@ultimat3/action';
import * as publishedPost from '../app/post/queries/published-post';
import * as publishedPosts from '../app/post/queries/published-posts';
import * as health from './health';

export const api = defineApi({
  actions: [health],
  queries: [publishedPosts, publishedPost],
});

/** What the typed client is shaped from — imported as a TYPE only by \`shared/client.ts\`. */
export type Api = typeof api;
`;

const apiIndexTest =
  (): string => `// The registration, read back: a read left out of the list is a route that answers 404.
import { expect, unitTest } from '@ultimat3/testing';
import { api } from './index';

unitTest('health and both public reads are registered under their export names', () => {
  expect(api.actions.health.describe().name).toBe('health');
  expect(api.queries.publishedPosts.describe().name).toBe('publishedPosts');
  expect(api.queries.publishedPost.describe().name).toBe('publishedPost');
});
`;

const edits = (app: NameSet): readonly ShapeEdit[] => [
  {
    path: 'packages/db/src/client.ts',
    find: 'const entities = {};',
    replace: 'const entities = {\n  posts: post,\n};',
  },
  {
    path: 'packages/db/src/client.ts',
    find: "import { storeMode } from '@ultimat3/core';",
    replace: `import { post } from '@${app.kebab}/web/app/post/entity';\nimport { storeMode } from '@ultimat3/core';`,
  },
  {
    path: 'packages/db/src/schema.ts',
    find: 'export {};',
    replace: `export { post } from '@${app.kebab}/web/app/post/entity';`,
  },
  {
    path: 'packages/db/package.json',
    find: '  "scripts": {',
    replace: `  "dependencies": {\n    "@${app.kebab}/web": "0.0.0"\n  },\n  "scripts": {`,
  },
  {
    path: 'apps/web/package.json',
    find: '  "dependencies": {\n',
    replace: `  "dependencies": {\n    "@${app.kebab}/db": "0.0.0",\n`,
  },
  // The admin's resource screens for `posts` are where a post is written.
  {
    path: 'apps/web/shared/roles.ts',
    find: "  'dashboard:read',\n]);",
    replace: "  'dashboard:read',\n  'posts:read',\n  'posts:write',\n  'posts:delete',\n]);",
  },
  {
    path: 'apps/web/shared/roles.ts',
    find: "    grants: ['admin:read', 'admin:write', 'admin:destroy', 'job:read', 'audit:read'],",
    replace: [
      '    grants: [',
      ...['admin:read', 'admin:write', 'admin:destroy', 'job:read', 'audit:read'].map(
        (grant) => `      '${grant}',`,
      ),
      "      'posts:read',",
      "      'posts:write',",
      "      'posts:delete',",
      '    ],',
    ].join('\n'),
  },
  ...claudeRows({
    page: '`apps/web/site/page.test.ts`',
    island: 'none in this shape: `bunx x g island <name>` writes one with its states',
  }),
  ...shapeLines(
    'blog',
    'a publication — `apps/web/site/` renders the `post` slice (`apps/web/app/post/`) with zero JavaScript, and `/admin` writes it',
  ),
];

export const blogShape: ShapeOverlay = {
  example: false,
  drop: [
    'apps/web/app/dashboard/',
    'apps/web/shared/shell',
    'apps/web/shared/theme-toggle.island',
    'apps/web/shared/browser-client',
  ],
  dropKeys: ['app.dashboard', 'shell', 'site.home'],
  edits,
  files: (app): readonly GeneratedFile[] => [
    ...blogSliceFiles(app),
    ...blogSiteFiles(app),
    { path: 'apps/web/api/index.ts', contents: apiIndex() },
    { path: 'apps/web/api/index.test.ts', contents: apiIndexTest() },
  ],
};
