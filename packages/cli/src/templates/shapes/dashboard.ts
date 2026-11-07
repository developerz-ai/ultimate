// `x new <name> --shape dashboard`: an internal tool. The default scaffold's dashboard, the `post`
// table and its job, `/admin` — plus a detail page each row links to, and sign-in, written by
// `x g sign-in --password` itself. The marketing `site/` stays a home page and the error documents.

import { catalogJson } from '../catalog-json';
import { catalogPath } from '../locales';
import type { GeneratedFile, NameSet } from '../naming';
import { dashboardDetailFiles } from './dashboard-detail';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { shapeLines } from './shared-edits';

const API = 'apps/web/api/index.ts';
const LIST_IMPORT = "import * as postList from '../app/post/live/post-list';\n";

const edits = (): readonly ShapeEdit[] => [
  {
    path: API,
    find: LIST_IMPORT,
    replace: `${LIST_IMPORT}import * as postById from '../app/post/queries/post-by-id';\n`,
  },
  { path: API, find: 'queries: [postList],', replace: 'queries: [postList, postById],' },
  // Each title is the link to its own page; the table stays links, no script.
  {
    path: 'apps/web/app/posts/page.tsx',
    find: 'cell: (row) => row.title,',
    replace: `cell: (row) => <a href={\`/posts/\${row.id}\`}>{row.title}</a>,`,
  },
  ...shapeLines(
    'dashboard',
    'an internal tool — the `post` table at `/posts` links each row to `apps/web/app/posts/[id]/page.tsx`, and `x g sign-in --password` wrote the sign-in',
  ),
];

/** The keys the detail page reads, merged into the catalog the base wrote. */
const catalog = (): GeneratedFile => ({
  path: catalogPath('en'),
  merge: 'json',
  contents: catalogJson({
    'app.post.back': 'All posts',
    'app.post.created': 'Created',
    'app.post.detail': 'Post',
    'app.post.missing': 'No such post in this organisation.',
  }),
});

export const dashboardShape: ShapeOverlay = {
  example: true,
  drop: [],
  dropKeys: [],
  edits,
  files: (app: NameSet): readonly GeneratedFile[] => [...dashboardDetailFiles(app), catalog()],
  generate: [['sign-in', '--password']],
};
