/**
 * The API surface: every action, mutator and query Postly exposes, registered in one place.
 * Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles, MCP tools and
 * test scaffolds.
 *
 * Registration takes whole modules, so the export name IS the primitive's name: there is no
 * second list of strings to keep in step with the declarations, and adding an action to a
 * feature is one edit rather than two. Two features exporting one name collide at registration
 * with `X_ACTION_DUPLICATE`; the `Api` intersection below would merge them silently, so the
 * runtime check is what enforces uniqueness, not the type.
 *
 * Importing this module IS the boot — the calls below run on import, and nothing else registers
 * anything. The only importer today is the framework's own module scan, which dynamic-imports
 * every file under an app's surface directories; that is what backs `x manifest`, `x routes`,
 * `x dev` and `x verify`. No long-running process imports it, because the entry that would —
 * `apps/web/server.ts`, what `x build --target binary` compiles and what the image starts as
 * `dist/server.js` — has not been written yet.
 */

import { registerActions } from '@ultimat3/action';
import { registerQueries } from '@ultimat3/query';
import * as orgActions from '../app/orgs/actions';
import * as postActions from '../app/posts/actions';
import * as postQueries from '../app/posts/live';
// A mutator IS an action, so it registers as one: the optimistic local twin rides on the same
// declaration instead of living in a parallel registry with a parallel authz path.
import * as postMutators from '../app/posts/mutator';
import * as settingsActions from '../app/settings-actions';

registerActions(postActions);
registerActions(postMutators);
registerActions(orgActions);
registerActions(settingsActions);

registerQueries(postQueries);

/** What the typed client is shaped from — imported as a TYPE only by `shared/client.ts`. */
export type Api = {
  readonly actions: typeof postActions &
    typeof postMutators &
    typeof orgActions &
    typeof settingsActions;
  readonly queries: typeof postQueries;
};
