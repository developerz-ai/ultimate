// `read_resource` / `write_resource` / `delete_resource` on a `'meta-split'` surface: locate (the
// visibility gate) → the tool its effect names, else `X_MCP_WRONG_TOOL` → the shared resolver →
// for `delete_resource`, preview unless `live: true`, and commit only with `confirmed_by_user:
// true` → the server's `dispatch`. Every call that runs goes through the flat path's one dispatch.

import {
  McpUserConfirmationRequiredError,
  McpWrongToolError,
  META_UNKNOWN_FIX,
} from './meta-errors';
import type { MetaHost } from './meta-host';
import { resolveAddressed } from './meta-host';
import { DELETE_RESOURCE, effectOf, toolForEffect } from './meta-split';
import type { MetaSurface } from './meta-surface';
import { schemaOf } from './meta-surface';
import type { AnyMcpTool, McpCaller, ToolArgs } from './registry';
import { jsonResult } from './registry';
import { admitted } from './tool-thrown';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { resultResponse } from './wire';

/** The tool-level arguments of `delete_resource`, accepted top-level or (where models put them) in `params`. */
const LIVE = 'live';
const CONFIRMED = 'confirmed_by_user';

export interface SplitRequest {
  readonly id: JsonRpcId;
  /** The dispatcher called: `read_resource`, `write_resource` or `delete_resource`. */
  readonly name: string;
  readonly caller: McpCaller;
  /** The envelope, already validated against the dispatcher's own schema. */
  readonly args: ToolArgs;
}

export async function splitCall(
  host: MetaHost,
  meta: MetaSurface,
  request: SplitRequest,
): Promise<JsonRpcResponse> {
  const { id, name, caller, args } = request;
  const resource = args['resource'] as string;
  const action = args['action'] as string;
  const tool = meta.locate(resource, action, caller);
  if (tool === undefined) return host.notFound(id, action, caller, META_UNKNOWN_FIX);
  // `assertEffects` refused an undeclared write at boot, so `effectOf` answers for a served tool.
  const effect = effectOf(tool) ?? 'delete';
  const useTool = toolForEffect(effect);
  if (useTool !== name) {
    // Visibility already passed, and the effect is what `list_resources` shows this caller: the
    // refusal names nothing the catalog did not.
    const wrong = new McpWrongToolError({ resource, action, called: name, useTool });
    return host.refuse(id, action, wrong, caller);
  }
  const params = isRecord(args['params']) ? args['params'] : {};
  if (name !== DELETE_RESOURCE) {
    return host.dispatch(id, action, resolveAddressed(host, tool, params, caller), caller);
  }
  const lifted = liftToolArgs(args, params, tool);
  const resolved = resolveAddressed(host, tool, lifted.params, caller);
  if (resolved.kind !== 'ok') return host.dispatch(id, action, resolved, caller);
  // The policy's actor half before any preview or confirmation prompt: a caller who may never run
  // this gets the denial, never an answer that rehearses the call.
  const refused = admitted(tool, caller);
  if (refused !== undefined) return host.refuse(id, action, refused, caller);
  if (lifted.live && lifted.confirmed !== true) {
    return host.refuse(
      id,
      action,
      new McpUserConfirmationRequiredError({ resource, action }),
      caller,
    );
  }
  // An action that declares `live` authors its own preview: it is handed `live: false` and runs.
  if (lifted.live || lifted.ownsPreview) return host.dispatch(id, action, resolved, caller);
  host.audit.toolCall({ tool: action, outcome: 'previewed', caller });
  return resultResponse(
    id,
    jsonResult({
      preview: true,
      ran: false,
      resource,
      action,
      params: resolved.args,
      commit_with: { live: true, [CONFIRMED]: true },
    }),
  );
}

interface Lifted {
  readonly params: Readonly<Record<string, unknown>>;
  readonly live: boolean;
  readonly confirmed: unknown;
  /** The action's own input declares `live`, so the preview is the action's to answer. */
  readonly ownsPreview: boolean;
}

/**
 * `live` and `confirmed_by_user` are the dispatcher's, not the action's: read top-level or from
 * `params` (nested wins, the precedence every other argument has) and removed from what the action
 * is handed — except `live` for an action whose own input declares it, which is then always
 * handed an explicit boolean so its preview branch never depends on its own default.
 */
function liftToolArgs(
  args: ToolArgs,
  params: Readonly<Record<string, unknown>>,
  tool: AnyMcpTool,
): Lifted {
  const declared = schemaOf(tool).properties ?? {};
  const ownsPreview = Object.hasOwn(declared, LIVE);
  // Nested wins, ALWAYS — a declared field too: a nested `confirmed_by_user: false` beside a
  // top-level `true` is a refusal, and reading the top level there would commit anyway.
  const pick = (key: string): unknown => (Object.hasOwn(params, key) ? params[key] : args[key]);
  const live = pick(LIVE) === true;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if ((key === LIVE || key === CONFIRMED) && !Object.hasOwn(declared, key)) continue;
    Object.defineProperty(rest, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (ownsPreview) rest[LIVE] = live;
  return { params: rest, live, confirmed: pick(CONFIRMED), ownsPreview };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
