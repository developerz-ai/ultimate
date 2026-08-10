/**
 * The API surface: every action, mutator and query Postly exposes, registered in one call.
 * Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles, MCP tools and
 * test scaffolds.
 *
 * `defineApi` takes whole modules, so the export name IS the primitive's name: there is no
 * second list of strings to keep in step with the declarations, and adding an action to a
 * feature is one edit rather than two. Two features exporting one name collide at registration
 * with `X_ACTION_DUPLICATE`.
 *
 * Importing this module IS the boot — the call below runs on import, and nothing else registers
 * anything. The only importer today is the framework's own module scan, which dynamic-imports
 * every file under an app's surface directories; that is what backs `x manifest`, `x routes`,
 * `x dev` and `x verify`. No long-running process imports it, because the entry that would —
 * `apps/web/server.ts`, what `x build --target binary` compiles and what the image starts as
 * `dist/server.js` — has not been written yet.
 */

import { defineApi } from '@ultimat3/action';
import * as orgActions from '../app/orgs/actions';
// `defineService('orgs', ...)` / `defineService('posts', ...)` run on import — the same
// "importing IS the boot" rule as the registration below, so `ctx.orgs` and `ctx.posts` are
// installed wherever this module has run, including tests.
import '../app/orgs/service';
import * as postActions from '../app/posts/actions';
import * as postQueries from '../app/posts/live';
// A mutator IS an action, so it registers as one: the optimistic local twin rides on the same
// declaration instead of living in a parallel registry with a parallel authz path.
import * as postMutators from '../app/posts/mutator';
import '../app/posts/service';
import * as settingsActions from '../app/settings/actions';

export const api = defineApi({
  actions: [postActions, orgActions, settingsActions],
  mutators: [postMutators],
  queries: [postQueries],
});

/** What the typed client is shaped from — imported as a TYPE only by `shared/client.ts`. */
export type Api = typeof api;
