/**
 * The API surface: every action, mutator, query, job and task Postly exposes, registered in one
 * call. Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles, MCP tools and
 * test scaffolds.
 *
 * `defineApi` takes whole modules, so the export name IS the primitive's name: there is no
 * second list of strings to keep in step with the declarations, and adding an action to a
 * feature is one edit rather than two. Two features exporting one name collide at registration
 * with `X_ACTION_DUPLICATE`.
 *
 * That is why the jobs and the task are handed over here too. A job or task module that nothing
 * registers keeps the positional name `job()` gave it — `anonymous-job-2` on the queue row, in
 * `x.manifest.json` and in every dead-letter trace, a name that appears nowhere in this source.
 *
 * Importing this module IS the boot — the call below runs on import, and nothing else registers
 * anything. Its importer is the framework's own module scan, which dynamic-imports every file
 * under an app's surface directories; that is what backs `x manifest`, `x routes`, `x dev`,
 * `x verify` and `apps/web/server.ts` — the production entry the image starts, which runs the
 * same scan rather than keeping a second import list that could disagree with this one.
 */

import { defineApi } from '@ultimat3/action';
import * as contactActions from '../app/contact/actions';
import * as contactJobs from '../app/contact/jobs';
import * as digestJobs from '../app/digest/jobs';
import * as orgActions from '../app/orgs/actions';
import * as orgJobs from '../app/orgs/jobs';
// `defineService('orgs', ...)` / `defineService('posts', ...)` run on import — the same
// "importing IS the boot" rule as the registration below, so `ctx.orgs` and `ctx.posts` are
// installed wherever this module has run, including tests.
import '../app/orgs/service';
import * as postActions from '../app/posts/actions';
import * as postJobs from '../app/posts/jobs';
import * as postQueries from '../app/posts/live';
// A mutator IS an action, so it registers as one: the optimistic local twin rides on the same
// declaration instead of living in a parallel registry with a parallel authz path.
import * as postMutators from '../app/posts/mutator';
import '../app/posts/service';
import * as settingsActions from '../app/settings/actions';
// A mutator IS an action, exactly like `postMutators` above.
import * as settingsMutators from '../app/settings/mutator';
import * as scheduledTasks from './tasks';

export const api = defineApi({
  actions: [postActions, orgActions, settingsActions, contactActions],
  mutators: [postMutators, settingsMutators],
  queries: [postQueries],
  jobs: [postJobs, orgJobs, digestJobs, contactJobs],
  tasks: [scheduledTasks],
});

/** What the typed client is shaped from — imported as a TYPE only by `shared/client.ts`. */
export type Api = typeof api;
