// `x new <name> --shape realtime`: multi-user live state across nodes. The default app — the live
// `postList`, the dashboard, `/admin` — plus the org's live room (a channel every member joins on
// whichever `sync` node it reached), a notifier that tells the room a post landed over the bus, and
// a rename every tab shows before the server answers (a mutator).
//
// Proved for two clients on two nodes over a real NATS (`realtime-nodes.ts`).

import { loadVersion } from '../../version-loader';
import type { NameSet } from '../naming';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { realtimeMutatorFiles } from './realtime-mutator';
import { realtimeNodeFiles } from './realtime-nodes';
import { realtimeSliceFiles } from './realtime-slice';
import { shapeLines } from './shared-edits';

const API = 'apps/web/api/index.ts';
const POLICY = 'apps/web/app/post/policy.ts';
const REPO = 'apps/web/app/post/repo.ts';
const CREATE = 'apps/web/app/post/actions/create-post.ts';
const CREATE_TEST = 'apps/web/app/post/actions/create-post.test.ts';
const CREATE_CONTRACT = 'apps/web/app/post/actions/create-post.contract.test.ts';
const QUEUE_ANCHOR =
  "// One store per process: without this, one test's rows are the next test's fixtures.\n";
/** The queue `postCreated` lands in, for this file: a process-global port, put back at its end. */
const QUEUE_SWAP =
  "// The queue createPost's enqueue lands in, swapped for this file and put back when it ends.\nbeforeAll(() => swapAdapter('jobs', memoryJobDriver()));\n\n";
const EXERCISE = 'apps/web/exercise.ts';
const ORG = "'00000000-0000-4000-8000-000000000002'";

const WRITE_RULE =
  "/** Write compares the org the action's input names with the actor's — grant it apart from read. */\n";

const REPO_TAIL = '  return db.posts.insert(row);\n}\n';

const CREATE_IMPORT = "import { PostView, post } from '../entity';\n";
const CREATE_RETURN = '    return service.create({ ...input, orgId: orgOf(ctx.actor) });\n';

/** An exercise entry: an actor of the scaffold's org holding `permission`, and that org as input. */
const exerciseEntry = (name: string, permission: string): string => `  ${name}: {
    actor: userActor({
      id: 'member',
      orgId: ${ORG},
      permissions: ['${permission}'],
    }),
    input: (drawn) => ({ ...drawn, orgId: ${ORG} }),
  },
`;

const edits = (): readonly ShapeEdit[] => [
  {
    path: POLICY,
    find: WRITE_RULE,
    replace: `/**
 * Joining the org's live room: the room is named by its \`orgId\` param, so the rule compares it with
 * the actor's — a member of another org is refused the topic, never sent its events.
 */
export const canPostWatch = can<PostScope>(
  'post:read',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);

${WRITE_RULE}`,
  },
  {
    path: REPO,
    find: REPO_TAIL,
    replace: `${REPO_TAIL}
/** One column of one row; the handle refuses a row outside the actor's org. */
export async function rename(id: string, title: string): Promise<Post> {
  return db.posts.update(id, { title });
}
`,
  },
  {
    path: CREATE,
    find: CREATE_IMPORT,
    replace: `${CREATE_IMPORT}import { postCreated } from '../jobs/post-created';\n`,
  },
  {
    path: CREATE,
    find: CREATE_RETURN,
    replace: `    const row = await service.create({ ...input, orgId: orgOf(ctx.actor) });
    // Enqueued in this request's transaction: a rolled-back create tells the room nothing.
    await postCreated.enqueue({ params: { id: row.id, orgId: row.orgId } });
    return row;
`,
  },
  // createPost now enqueues, and a test process installs no queue: each suite that runs its
  // handler swaps in the memory driver, as the job suite next door does.
  {
    path: CREATE_TEST,
    find: "import { testActor } from '@ultimat3/policy';\nimport { afterEach, expect, unitTest } from '@ultimat3/testing';\n",
    replace:
      "import { memoryJobDriver } from '@ultimat3/jobs';\nimport { testActor } from '@ultimat3/policy';\nimport { afterEach, beforeAll, expect, swapAdapter, unitTest } from '@ultimat3/testing';\n",
  },
  { path: CREATE_TEST, find: QUEUE_ANCHOR, replace: `${QUEUE_SWAP}${QUEUE_ANCHOR}` },
  {
    path: CREATE_CONTRACT,
    find: "import { testActor } from '@ultimat3/policy';\nimport { contractTest, expect } from '@ultimat3/testing';\n",
    replace:
      "import { memoryJobDriver } from '@ultimat3/jobs';\nimport { testActor } from '@ultimat3/policy';\nimport { beforeAll, contractTest, expect, swapAdapter } from '@ultimat3/testing';\n",
  },
  {
    path: CREATE_CONTRACT,
    find: "const target = createPost.named('createPost');\n",
    replace: `const target = createPost.named('createPost');\n\n${QUEUE_SWAP}`,
  },
  {
    path: API,
    find: "import * as createPost from '../app/post/actions/create-post';\n",
    replace: `import * as createPost from '../app/post/actions/create-post';
import * as renamePost from '../app/post/actions/rename-post';
import * as postCreated from '../app/post/jobs/post-created';
`,
  },
  {
    path: API,
    find: "import * as postList from '../app/post/live/post-list';\n",
    replace: `import * as postList from '../app/post/live/post-list';
import * as recentPosts from '../app/post/queries/recent-posts';
`,
  },
  {
    path: API,
    find: 'actions: [health, createPost, archivePost],',
    replace: 'actions: [health, createPost, archivePost, renamePost],',
  },
  { path: API, find: 'queries: [postList],', replace: 'queries: [postList, recentPosts],' },
  { path: API, find: 'jobs: [reindexPost],', replace: 'jobs: [reindexPost, postCreated],' },
  {
    path: EXERCISE,
    find: '  },\n});\n',
    replace: `  },\n${exerciseEntry('renamePost', 'post:write')}${exerciseEntry('recentPosts', 'post:read')}});\n`,
  },
  // The room and the notifier import both; an isolated install resolves only what the app declares.
  {
    path: 'package.json',
    find: '    "@ultimat3/policy": ',
    replace: `    "@ultimat3/notify": "${loadVersion()}",\n    "@ultimat3/policy": `,
  },
  {
    path: 'package.json',
    find: '    "@ultimat3/render": ',
    replace: `    "@ultimat3/realtime": "${loadVersion()}",\n    "@ultimat3/render": `,
  },
  ...shapeLines(
    'realtime',
    "multi-user live state across nodes — a notifier tells the org's room (`apps/web/app/post/channels.ts`) of each new post over the bus; two `sync` nodes in `apps/web/app/post/channels.live.test.ts`",
  ),
];

export const realtimeShape: ShapeOverlay = {
  example: true,
  drop: [],
  dropKeys: [],
  edits,
  files: (app: NameSet) => [
    ...realtimeSliceFiles(app),
    ...realtimeMutatorFiles(app),
    ...realtimeNodeFiles(app),
  ],
};
