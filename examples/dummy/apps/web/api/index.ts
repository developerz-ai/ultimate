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

// `mcpConfirmations()` returns an ACTION — the one a person approves an agent's gated call with —
// so it registers here like any other. From its own module: `@postly/mcp`'s index builds the MCP
// server, which snapshots the registry and must load after this call, never inside it.
import * as mcpConfirmationActions from '@postly/mcp/confirmations';
import { defineApi } from '@ultimat3/action';
import * as authActions from '../app/auth/actions';
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
import '../app/posts/channels';
// A backfill IS a job — `backfill()` is a factory over `job()` — so it registers in the `jobs`
// list and nowhere else. It carries its own `name`, unlike a plain job whose export name becomes
// its queue key, because a sweep's name is a durable key the `x_backfills` ledger already holds.
import * as postBackfills from '../app/posts/backfills/post-excerpts';
import * as postJobs from '../app/posts/jobs';
import * as postQueries from '../app/posts/live';
// A mutator IS an action, so it registers as one: the optimistic local twin rides on the same
// declaration instead of living in a parallel registry with a parallel authz path.
import * as postMutators from '../app/posts/mutator';
// `notifier()` is a job factory, so a notification registers in the `jobs` list.
import * as postNotifiers from '../app/posts/notifiers';
import '../app/posts/service';
import * as mcpJobs from '../app/mcp/jobs';
import * as runActions from '../app/runs/actions';
// `scrape()` is a job factory, so the sync registers in the `jobs` list like any other job. It
// names itself (`runs.sync`): a scrape's name is a durable queue key, never an export name.
import * as runJobs from '../app/runs/jobs';
import { RUN_KEY_SCOPES, resolveRunKey } from '../app/runs/keys';
import * as runQueries from '../app/runs/live';
import '../app/runs/service';
import * as settingsActions from '../app/settings/actions';
// A mutator IS an action, exactly like `postMutators` above.
import * as settingsMutators from '../app/settings/mutator';
import * as webhookActions from '../app/webhooks/actions';
// `webhook()` is a job factory, so a delivery registers in the `jobs` list. It names itself
// (`posts.published.webhook`): a delivery's name is a durable queue key, never an export name.
import * as webhookJobs from '../app/webhooks/jobs';
import '../app/webhooks/service';
import * as scheduledTasks from './tasks';

export const api = defineApi({
  actions: [
    postActions,
    orgActions,
    settingsActions,
    contactActions,
    authActions,
    runActions,
    webhookActions,
    mcpConfirmationActions,
  ],
  mutators: [postMutators, settingsMutators],
  queries: [postQueries, runQueries],
  jobs: [
    postJobs,
    postNotifiers,
    postBackfills,
    orgJobs,
    digestJobs,
    contactJobs,
    runJobs,
    mcpJobs,
    webhookJobs,
    // `agentJob()` is a job factory declared BESIDE the agent it wraps (`reviewDraftLater`, which
    // reads `reviewDraft` at module scope), so the actions module is handed over here too. Each
    // registrar takes only its own kind, so neither list double-registers anything.
    postActions,
  ],
  tasks: [scheduledTasks],
  // A second door for machine callers, onto the run actions a browser already calls: same
  // handler, same policy, a bearer key instead of a session. `/api/runs/start` is `/v1/runs/start`.
  http: { mounts: [{ prefix: '/v1', scopes: RUN_KEY_SCOPES, resolveToken: resolveRunKey }] },
});

/** What the typed client is shaped from — imported as a TYPE only by `shared/client.ts`. */
export type Api = typeof api;
