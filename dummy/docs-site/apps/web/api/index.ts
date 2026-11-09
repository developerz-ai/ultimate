/**
 * The API surface: every action, mutator, query, job and task this app exposes, registered in one
 * call. Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles and MCP tools.
 *
 * `defineApi` takes whole MODULES, so the export name IS the primitive's name: there is no second
 * list of strings to keep in step with the declarations, and adding an action to a feature is one
 * edit rather than two. Two features exporting one name collide with X_ACTION_DUPLICATE.
 *
 * That is why the jobs are handed over here too, and it is the half an app cannot skip: the
 * framework's module scan registers actions and queries on its own, and registers NO job — so a
 * job module nothing lists keeps the positional name `job()` gave it, `anonymous-job-2`, on the
 * queue row, in `x.manifest.json` and in every dead-letter trace.
 *
 * Importing this module IS the registration: the call below runs on import, and the importer is
 * the framework's own scan of `apps/*`, which is what backs `x manifest`, `x routes`, `x dev`,
 * `x verify` and `apps/web/server.ts` alike.
 */

import { defineApi } from '@ultimat3/action';
import * as health from './health';

export const api = defineApi({
  actions: [health],
});

/** What the typed client is shaped from — imported as a TYPE only by `shared/browser-client.ts`. */
export type Api = typeof api;
