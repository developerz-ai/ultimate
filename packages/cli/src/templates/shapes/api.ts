// `x new <name> --shape api`: the example `post` slice as an API — actions, a live query and a job,
// served over a session, an org API key on `/v1`, OpenAPI and MCP. No page beyond the error
// documents and the offline fallback, no island, no app UI. `/admin` stays: it is the operator's
// console. The PWA block stays too: a page `x g` writes into this app is tested offline.

import type { GeneratedFile, NameSet } from '../naming';
import { apiKeyFiles } from './api-keys';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { claudeRows, shapeLines } from './shared-edits';

const apiIndex = (app: NameSet): string => `/**
 * The API surface: every action, query and job this app exposes, registered in one call. From this
 * list the framework projects HTTP routes, \`openapi.json\`, the typed client, job handles and MCP
 * tools. \`defineApi\` takes whole MODULES, so the export name IS the primitive's name.
 *
 * Two doors onto the same handlers: a session (or \`x dev\`'s development viewer) on \`/api\`, and an
 * org's API key on \`/v1\` — cut by \`API_KEY_SCOPES\`, so a read-only key reaches \`postList\` only.
 */

import { defineApi } from '@ultimat3/action';
import * as issueKey from '../app/keys/actions/issue-key';
import { API_KEY_SCOPES, resolveApiKey } from '../app/keys/keys';
import * as archivePost from '../app/post/actions/archive-post';
import * as createPost from '../app/post/actions/create-post';
import * as reindexPost from '../app/post/jobs/reindex-post';
import * as postList from '../app/post/live/post-list';
import * as health from './health';

export const api = defineApi({
  actions: [health, createPost, archivePost, issueKey],
  queries: [postList],
  jobs: [reindexPost],
  http: { mounts: [{ prefix: '/v1', scopes: API_KEY_SCOPES, resolveToken: resolveApiKey }] },
  // Declared, so \`openapi.json\` is the complete document: every operation, both security schemes.
  openapi: { title: '${app.pascal}', version: '1.0.0' },
});

/** What a typed client is shaped from. */
export type Api = typeof api;
`;

const apiIndexTest =
  (): string => `// The registration, read back: an action left out of the list is a route that answers 404 with
// every test of the action itself still green.
import { expect, unitTest } from '@ultimat3/testing';
import { API_KEY_SCOPES } from '../app/keys/keys';
import { api } from './index';

unitTest('every action, the live query and the job are registered under their export names', () => {
  for (const name of ['health', 'createPost', 'archivePost', 'issueKey'] as const) {
    expect(api.actions[name].describe().name).toBe(name);
  }
  expect(api.queries.postList.isLive).toBe(true);
  expect(api.jobs.reindexPost.name).toBe('reindexPost');
});

unitTest('every operation a key scope names is registered', () => {
  const registered = new Set([...Object.keys(api.actions), ...Object.keys(api.queries)]);
  for (const names of Object.values(API_KEY_SCOPES)) {
    for (const name of names)
      expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true });
  }
});
`;

const edits = (): readonly ShapeEdit[] => [
  {
    path: 'apps/web/shared/roles.ts',
    find: "    grants: [\n      'admin:read',",
    replace: "    grants: [\n      'key:issue',\n      'admin:read',",
  },
  ...claudeRows({
    page: 'none in this shape: `bunx x g route <name>` writes one with its test',
    island: 'none in this shape: `bunx x g island <name>` writes one with its states',
  }),
  ...shapeLines(
    'api',
    'an API — `apps/web/api/index.ts` registers every primitive, `/v1` takes an org API key (`apps/web/app/keys/`)',
  ),
];

export const apiShape: ShapeOverlay = {
  example: true,
  drop: [
    'apps/web/app/dashboard/',
    'apps/web/app/posts/',
    'apps/web/app/post/post-form.island.',
    'apps/web/app/post/ui',
    'apps/web/shared/shell',
    'apps/web/shared/theme-toggle.island',
    'apps/web/shared/browser-client',
    'apps/web/site/page.',
  ],
  dropKeys: ['app.dashboard', 'app.post', 'app.posts', 'shell', 'site'],
  edits,
  files: (app): readonly GeneratedFile[] => [
    ...apiKeyFiles(),
    { path: 'apps/web/api/index.ts', contents: apiIndex(app) },
    { path: 'apps/web/api/index.test.ts', contents: apiIndexTest() },
  ],
};
