/**
 * What the server says to a caller that derived an action's URL under the WRONG path style: a
 * script or another service passing `rpc({ pathStyle })` by hand, where matching build ids prove
 * nothing. Handed to `@ultimat3/http` as `hooks.explainMiss`, so it runs only when the router
 * matched nothing — and answers `X_CONTRACT_DRIFT` naming the style served, in place of a
 * `X_ROUTE_NOT_FOUND` that sends the caller looking for a route that exists.
 */

import type { ActionPathStyle } from '@ultimat3/core';
import { ACTION_PATH_PREFIX, ACTION_PATH_STYLES, actionRoute } from '@ultimat3/core';
import { ContractDriftError } from './errors';
import { actionPathStyle, servedActionRoute } from './http-path';
import { defOf } from './invoke';
import { seatedActions } from './registry-store';

/**
 * The action `pathname` names under a style this app does not serve, or `undefined`. A pinned
 * action is skipped: its URL is the pin under every style, so no style explains missing it.
 *
 * A walk of the registry per miss, and deliberately not an index: the registry and the style both
 * move (`x dev` re-evaluates modules), and only a POST under `/api/` that matched no route pays —
 * one string derivation per action, no I/O.
 */
function driftedAction(
  pathname: string,
): { readonly name: string; readonly under: ActionPathStyle } | undefined {
  const served = actionPathStyle();
  for (const under of ACTION_PATH_STYLES) {
    if (under === served) continue;
    // why no index: a memo keyed by path would outlive a re-registration and name a stale action.
    for (const [name, seated] of seatedActions) {
      if (defOf(seated).http?.path !== undefined) continue;
      if (actionRoute(name, under).path === pathname) return { name, under };
    }
  }
  return undefined;
}

/**
 * `hooks.explainMiss` for the action surface. Every value in the message is the framework's own:
 * the name is a registered export name and both paths are derived from it — the caller's bytes
 * reach the message only by being equal to one of them.
 */
export function explainActionPathMiss(
  method: string,
  pathname: string,
): ContractDriftError | undefined {
  if (method !== 'POST' || !pathname.startsWith(`${ACTION_PATH_PREFIX}/`)) return undefined;
  const drifted = driftedAction(pathname);
  if (drifted === undefined) return undefined;
  const served = actionPathStyle();
  return new ContractDriftError(
    `POST ${pathname} is ${drifted.name} under pathStyle '${drifted.under}'; this server serves pathStyle '${served}', where it is POST ${servedActionRoute(drifted.name).path}`,
    `rpc<Api['actions']>({ baseUrl, pathStyle: '${served}' })   # in a browser, pass no pathStyle: the page states it`,
  );
}
