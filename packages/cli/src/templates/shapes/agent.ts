// `x new <name> --shape agent`: the default app plus an LLM agent with a tool and an MCP surface.
// `apps/web/app/assistant/` holds `suggestTitle` (an `agent()`), the action it calls as a tool, the
// code that keeps its answer, and that as a queued `agentJob()`. The model is the environment's
// alone (`LLM_*`): unset, the app boots and gates on the scripted model its tests install.

import { loadVersion } from '../../version-loader';
import type { GeneratedFile, NameSet } from '../naming';
import { actionFiles } from './agent-actions';
import { jobFiles } from './agent-job';
import { ASSISTANT_DIR, modelEdits, modelFiles } from './agent-model';
import { promptFiles } from './agent-prompt';
import { scriptedFiles } from './agent-scripted';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { shapeLines } from './shared-edits';

const API = 'apps/web/api/index.ts';
const FIRST_IMPORT = "import * as archivePost from '../app/post/actions/archive-post';\n";
const ORG = '00000000-0000-4000-8000-000000000002';

const imports = [
  "import * as draftPost from '../app/assistant/actions/draft-post';",
  "import * as postTitles from '../app/assistant/actions/post-titles';",
  "import * as queueDraft from '../app/assistant/actions/queue-draft';",
  "import * as suggestTitle from '../app/assistant/actions/suggest-title';",
  "import * as draftPostLater from '../app/assistant/jobs/draft-post-later';",
].join('\n');

/** Every primitive the assistant adds, registered beside the example slice's. */
const apiEdits = (): readonly ShapeEdit[] => [
  { path: API, find: FIRST_IMPORT, replace: `${imports}\n${FIRST_IMPORT}` },
  {
    path: API,
    find: 'actions: [health, createPost, archivePost],',
    replace:
      'actions: [health, createPost, archivePost, postTitles, suggestTitle, draftPost, queueDraft],',
  },
  { path: API, find: 'jobs: [reindexPost],', replace: 'jobs: [reindexPost, draftPostLater],' },
];

/** The role a queued draft acts as (`jobs/draft-post-later.ts`): reads and writes posts, no more. */
const roleEdit: ShapeEdit = {
  path: 'apps/web/shared/roles.ts',
  find: "    inherits: ['member'],\n  },\n});",
  replace: [
    "    inherits: ['member'],",
    '  },',
    '  assistant: {',
    "    description: 'The in-app agent, acting for its org in a queued run: reads and drafts posts.',",
    "    grants: ['post:read', 'post:write'],",
    '  },',
    '});',
  ].join('\n'),
};

const EXERCISE_ANCHOR = 'export const exercise = defineExercise({\n';

/** `x exercise` installs no model: the three that call one say so, the two that do not are run. */
const exerciseEdit: ShapeEdit = {
  path: 'apps/web/exercise.ts',
  find: EXERCISE_ANCHOR,
  replace: `/** The one service \`x exercise\` cannot install: the model \`LLM_MODEL\` names. */
const NO_MODEL = 'calls the model LLM_MODEL names: x exercise installs no AI gateway';

${EXERCISE_ANCHOR}  postTitles: {
    actor: userActor({
      id: 'member',
      orgId: '${ORG}',
      permissions: ['post:read'],
    }),
  },
  queueDraft: {
    actor: userActor({
      id: 'member',
      orgId: '${ORG}',
      permissions: ['post:write'],
    }),
  },
  suggestTitle: { off: NO_MODEL },
  draftPost: { off: NO_MODEL },
  'assistant.draft-post': { off: NO_MODEL },
`,
};

const apiTest =
  (): string => `// The assistant's registration, read back: an agent left out of the list is a route that answers
// 404 and a tool no MCP client is offered, with every test of the agent itself still green.
import { expect, unitTest } from '@ultimat3/testing';
import { api } from '../../api/index';

unitTest('the tool, the agent, the keeper, the queue and the job are registered', () => {
  for (const name of ['postTitles', 'suggestTitle', 'draftPost', 'queueDraft'] as const) {
    expect(api.actions[name].describe().name).toBe(name);
  }
  // A job is keyed by its declared queue name, never its export: renaming one moves no queued row.
  expect(Object.values(api.jobs).map((job) => job.name)).toContain('assistant.draft-post');
});

unitTest('the agent and its tool are MCP tools; the keeper is not', () => {
  expect(api.actions.suggestTitle.mcp?.expose).toBe(true);
  expect(api.actions.postTitles.mcp?.expose).toBe(true);
  expect(api.actions.queueDraft.mcp?.expose).toBe(true);
  expect(api.actions.draftPost.mcp?.expose).toBeUndefined();
});
`;

/** `@ultimat3/ai` joins the app's dependencies at the release's range: the agent imports it. */
const dependencyEdit = (): ShapeEdit => ({
  path: 'package.json',
  find: '    "@ultimat3/auth": ',
  replace: `    "@ultimat3/ai": "^${loadVersion()}",\n    "@ultimat3/auth": `,
});

const edits = (): readonly ShapeEdit[] => [
  dependencyEdit(),
  ...apiEdits(),
  roleEdit,
  exerciseEdit,
  ...modelEdits(),
  ...shapeLines(
    'agent',
    'an LLM agent — `apps/web/app/assistant/actions/suggest-title.ts` calls `postTitles` as its tool, both are MCP tools on `POST /mcp`, `queueDraft` runs it as a job, and `LLM_MODEL` in the environment (`.env.example`) names the model',
  ),
];

export const agentShape: ShapeOverlay = {
  example: true,
  drop: [],
  dropKeys: [],
  edits,
  files: (app: NameSet): readonly GeneratedFile[] => [
    ...modelFiles(),
    ...scriptedFiles(),
    ...promptFiles(),
    ...actionFiles(app.kebab),
    ...jobFiles(app.kebab),
    { path: `${ASSISTANT_DIR}/api.test.ts`, contents: apiTest() },
  ],
};
