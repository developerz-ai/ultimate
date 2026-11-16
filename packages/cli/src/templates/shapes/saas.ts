// `x new <name> --shape saas`: the default app — every table tenant-scoped by `orgId`, the
// `member` and `admin` roles, `/admin` — plus billing as app code (`apps/web/app/billing/`), a
// signed payment webhook that moves an org between plans, a plan-sized usage meter on `createPost`,
// and sign-in and the member invite, each written by its own generator once the files land.

import { loadVersion } from '../../version-loader';
import { catalogJson } from '../catalog-json';
import { catalogPath } from '../locales';
import type { GeneratedFile, NameSet } from '../naming';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { BILLING_DIR, billingFiles } from './saas-billing';
import { billingReceiverFiles, RECEIVER_NAME } from './saas-receiver';
import { shapeLines } from './shared-edits';

const API = 'apps/web/api/index.ts';
const CREATE_POST = 'apps/web/app/post/actions/create-post.ts';
const ROLES = 'apps/web/shared/roles.ts';
const RECEIVER_MODULE = `../app/billing/jobs/${RECEIVER_NAME}`;

const edits = (app: NameSet): readonly ShapeEdit[] => [
  // The receiver is a job: listed, so the boot registers it under its name and mounts its route.
  {
    path: API,
    find: "import { defineApi } from '@ultimat3/action';\n",
    replace: `import { defineApi } from '@ultimat3/action';\nimport * as billingEvents from '${RECEIVER_MODULE}';\n`,
  },
  { path: API, find: 'jobs: [reindexPost],', replace: 'jobs: [reindexPost, billingEvents],' },
  // The subscription table joins the typed handle, as `x g entity` would add it.
  {
    path: 'packages/db/src/client.ts',
    find: `import { post } from '@${app.kebab}/web/app/post/entity';\n`,
    replace: `import { subscription } from '@${app.kebab}/web/app/billing/entity';\nimport { post } from '@${app.kebab}/web/app/post/entity';\n`,
  },
  {
    path: 'packages/db/src/client.ts',
    find: '  posts: post,\n};',
    replace: '  posts: post,\n  subscriptions: subscription,\n};',
  },
  {
    path: 'packages/db/src/schema.ts',
    find: `export { post } from '@${app.kebab}/web/app/post/entity';`,
    replace: `export { subscription } from '@${app.kebab}/web/app/billing/entity';\nexport { post } from '@${app.kebab}/web/app/post/entity';`,
  },
  // The usage meter: an org creates as many posts a day as its plan allows.
  {
    path: CREATE_POST,
    find: "import { PostView, post } from '../entity';\n",
    replace:
      "import { postMeter } from '../../billing/entitlements';\nimport { PostView, post } from '../entity';\n",
  },
  {
    path: CREATE_POST,
    find: '  cache: { invalidates: [postTag] },\n',
    replace:
      "  cache: { invalidates: [postTag] },\n  // The org's plan sizes it (`billing/plans.ts`); past it, X_METER_EXCEEDED (429).\n  meter: postMeter,\n",
  },
  // A plan is the payment provider's to change: an operator reads subscriptions at /admin, and no
  // role is granted a write the webhook would only overwrite.
  {
    path: ROLES,
    find: "  'posts:delete',\n]);",
    replace: "  'posts:delete',\n  'subscriptions:read',\n]);",
  },
  {
    path: ROLES,
    find: "      'posts:delete',\n    ],",
    replace: "      'posts:delete',\n      'subscriptions:read',\n    ],",
  },
  {
    path: 'apps/admin/app/admin/admin.ts',
    find: '  entities: adminEntitiesOf(db),\n  db,\n',
    replace:
      "  entities: adminEntitiesOf(db),\n  db,\n  // A plan is the payment webhook's to write (`apps/web/app/billing/`): operators only read it.\n  resources: { subscriptions: { operations: ['list', 'detail', 'search'] } },\n",
  },
  // A plan's features are flags: the package joins the app's dependencies, at the release's range.
  {
    path: 'package.json',
    find: '    "@ultimat3/http": "^',
    replace: `    "@ultimat3/flags": "^${loadVersion()}",\n    "@ultimat3/http": "^`,
  },
  ...shapeLines(
    'saas',
    `a multi-tenant app — billing is app code in \`${BILLING_DIR}/plans.ts\`, a signed payment webhook (\`${BILLING_DIR}/jobs/${RECEIVER_NAME}.ts\`) moves an org between plans, and \`x g sign-in --password\` and \`x g invite\` wrote sign-in and the member invite`,
  ),
];

/** The labels `/admin` derives for the subscriptions table, merged into the catalog the base wrote. */
const catalog = (): GeneratedFile => ({
  path: catalogPath('en'),
  merge: 'json',
  contents: catalogJson({
    'admin.subscriptions.title': 'Subscriptions',
    'admin.subscriptions.field.id': 'ID',
    'admin.subscriptions.field.orgId': 'Org ID',
    'admin.subscriptions.field.plan': 'Plan',
    'admin.subscriptions.field.lastEventId': 'Last payment event',
    'admin.subscriptions.field.updatedAt': 'Updated at',
  }),
});

export const saasShape: ShapeOverlay = {
  example: true,
  drop: [],
  dropKeys: [],
  edits,
  files: (app: NameSet): readonly GeneratedFile[] => [
    ...billingFiles(app),
    ...billingReceiverFiles(),
    catalog(),
  ],
  generate: [['sign-in', '--password'], ['invite']],
};
