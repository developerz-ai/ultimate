// `apps/web/api` — the surface with no rendering behind it: the health action, and the one call
// that hands every primitive this app declares to the framework by name.
// Split from scaffold-app.ts because that file is the three SURFACES and this is one of them, and
// because `index.ts` has to know the example slice's own file layout.

import type { GeneratedFile } from './naming';

const healthAction =
  (): string => `// api/ holds actions only: no rendering, no components. This one is the readiness probe every
// role exposes, declared as an action so it appears in OpenAPI and MCP like everything else.

import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';

export const health = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean, role: t.string }),
  // Public, said out loud. \`can('x:y')\` is the other branch; a missing policy is a build error,
  // so "anyone may call this" has to be a declaration too.
  policy: allow('public'),
  mcp: { expose: true, description: 'Readiness of this process' },
  async handle({ ctx }) {
    return { ok: true, role: ctx.role };
  },
});
`;

const healthTest =
  (): string => `// The health action's contract, run as the framework generates it: garbage input refused, the
// operation in the OpenAPI document. The declaration is the source; this only runs it.
import { contractTest, expect } from '@ultimat3/testing';
import { health } from './health';

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerActions\` stamps the same name onto the same object.
const target = health.named('health');

contractTest('health is an action exposed over MCP', () => {
  expect(target.kind).toBe('action');
  expect(target.mcp?.expose).toBe(true);
});

contractTest('health projects one MCP tool and one OpenAPI operation', () => {
  // Same policy object on both surfaces — a public action says so once, not once per surface.
  expect(target.tool().policy).toBe(target.policy);
  expect(target.openapi().operationId).toBe('health');
});
`;

/** The imports and the lists that differ between `x new` and `x new --no-example`. */
const exampleSlice = {
  imports: `import * as archivePost from '../app/post/actions/archive-post';
import * as createPost from '../app/post/actions/create-post';
import * as reindexPost from '../app/post/jobs/reindex-post';
import * as postList from '../app/post/live/post-list';
`,
  actions: ', createPost, archivePost',
  extra: `
  queries: [postList],
  jobs: [reindexPost],`,
};

const apiIndex = (example: boolean): string => {
  const slice = example ? exampleSlice : { imports: '', actions: '', extra: '' };
  return `/**
 * The API surface: every action, mutator, query, job and task this app exposes, registered in one
 * call. Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, \`openapi.json\`, the typed client, job handles and MCP tools.
 *
 * \`defineApi\` takes whole MODULES, so the export name IS the primitive's name: there is no second
 * list of strings to keep in step with the declarations, and adding an action to a feature is one
 * edit rather than two. Two features exporting one name collide with X_ACTION_DUPLICATE.
 *
 * That is why the jobs are handed over here too, and it is the half an app cannot skip: the
 * framework's module scan registers actions and queries on its own, and registers NO job — so a
 * job module nothing lists keeps the positional name \`job()\` gave it, \`anonymous-job-2\`, on the
 * queue row, in \`x.manifest.json\` and in every dead-letter trace.
 *
 * Importing this module IS the registration: the call below runs on import, and the importer is
 * the framework's own scan of \`apps/*\`, which is what backs \`x manifest\`, \`x routes\`, \`x dev\`,
 * \`x verify\` and \`apps/web/server.ts\` alike.
 */

import { defineApi } from '@ultimat3/action';
${slice.imports}import * as health from './health';

export const api = defineApi({
  actions: [health${slice.actions}],${slice.extra}
});
`;
};

/** `apps/web/api` for a new app: the readiness action, its contract test, and the registration. */
export function apiFiles(example: boolean): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/api/health.ts', contents: healthAction() },
    { path: 'apps/web/api/health.contract.test.ts', contents: healthTest() },
    { path: 'apps/web/api/index.ts', contents: apiIndex(example) },
  ];
}
