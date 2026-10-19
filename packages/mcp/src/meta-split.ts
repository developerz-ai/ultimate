// The `'meta-split'` surface's dispatchers: `read_resource`, `write_resource`, `delete_resource`
// in place of the one `manage_resource`, each picked from the action's declared effect. A client
// decides whether to ask its user from a TOOL's annotations alone, and a directory refuses a tool
// that both reads and writes — so the split is by tool, never by a flag inside the envelope.
// Catalog and boot check here; the dispatch is `meta-split-call.ts`, on the shared path.

import type { McpEffect } from '@ultimat3/core';
import { McpEffectConflictError, McpEffectUndeclaredError } from './meta-errors';
import type { AnyMcpTool, ToolListEntry } from './registry';
import type { JsonSchema } from './wire';

export const READ_RESOURCE = 'read_resource';
export const WRITE_RESOURCE = 'write_resource';
export const DELETE_RESOURCE = 'delete_resource';
export const SPLIT_DISPATCHERS: readonly string[] = [
  READ_RESOURCE,
  WRITE_RESOURCE,
  DELETE_RESOURCE,
];

/** What a grouped tool does, as the split surface reads it: a read, or its declared effect. */
export type McpEffectClass = 'read' | McpEffect;

/** The dispatcher that runs each class. */
export function toolForEffect(effect: McpEffectClass): string {
  if (effect === 'read') return READ_RESOURCE;
  return effect === 'write' ? WRITE_RESOURCE : DELETE_RESOURCE;
}

/**
 * `destructive === false` is a read, as `headOf` and `verbClass` read it; anything else is its
 * declared effect, or `undefined` — which `assertEffects` refuses at boot, so a served tool always
 * has one.
 */
export function effectOf(tool: AnyMcpTool): McpEffectClass | undefined {
  return tool.destructive === false ? 'read' : tool.effect;
}

/**
 * Boot: every grouped write names its effect, and no read names one. No default either way — a
 * wrong one hides a deletion behind `write_resource`, or asks deletion-grade consent for an
 * update. Every undeclared name is collected first, so one boot lists them all.
 */
export function assertEffects(tools: Iterable<AnyMcpTool>): void {
  const undeclared: string[] = [];
  for (const tool of tools) {
    if (tool.destructive === false) {
      if (tool.effect !== undefined) {
        throw new McpEffectConflictError({ name: tool.name, effect: tool.effect });
      }
    } else if (tool.effect !== 'write' && tool.effect !== 'delete') {
      undeclared.push(tool.name);
    }
  }
  if (undeclared.length > 0) throw new McpEffectUndeclaredError({ names: undeclared.sort() });
}

const ENVELOPE: Readonly<Record<string, JsonSchema>> = {
  resource: { type: 'string', description: 'Resource name, as list_resources shows it.' },
  action: { type: 'string', description: 'Action name, as list_resources shows it.' },
  params: {
    type: 'object',
    description: "The action's parameters, as describe_resource lists them.",
  },
};

const envelope = (extra: Readonly<Record<string, JsonSchema>> = {}, required: string[] = []) =>
  ({
    type: 'object',
    properties: { ...ENVELOPE, ...extra },
    required: ['resource', 'action', ...required],
    additionalProperties: false,
  }) satisfies JsonSchema;

/** The three dispatchers as `tools/list` publishes them. Descriptions state facts, never orders. */
export const SPLIT_TOOL_ENTRIES: readonly ToolListEntry[] = [
  {
    name: READ_RESOURCE,
    title: 'Read',
    description:
      'Runs one read-only action of one resource: { resource, action, params }. Changes nothing. list_resources shows which actions it runs (untagged ones); any other action is refused with X_MCP_WRONG_TOOL naming its tool.',
    inputSchema: envelope(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: WRITE_RESOURCE,
    title: 'Write',
    description:
      'Runs one action of one resource that creates or changes state: { resource, action, params }. Same policies, scopes and audit as calling the action directly. Runs the actions list_resources tags (write); any other is refused with X_MCP_WRONG_TOOL naming its tool.',
    inputSchema: envelope(),
    // An update can overwrite state, so the honest hint for a write is still destructive.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: DELETE_RESOURCE,
    title: 'Delete, send or spend',
    description:
      "Runs one action that archives, cancels or deletes, sends something outside the app, or commits money: { resource, action, params, live, confirmed_by_user }. live: false or absent answers a preview — the framework's, which runs nothing, or the action's own when its input declares live; live: true runs it, only with confirmed_by_user: true. Runs the actions list_resources tags (delete).",
    inputSchema: envelope(
      {
        live: {
          type: 'boolean',
          description:
            "true runs the action; false or absent answers a preview: the framework's runs nothing, and an action whose params declare live answers its own.",
        },
        confirmed_by_user: {
          type: 'boolean',
          description:
            'true when the user approved this change, directly or by authorizing the task that includes it. A live call without true runs nothing and answers X_MCP_USER_CONFIRMATION_REQUIRED.',
        },
      },
      // Not `required`: both flags may ride inside `params` (nested wins), and a schema requiring
      // the top-level one refused that call as X_INPUT_INVALID before the dispatcher read it
      // (#798). The dispatcher is the one gate: a live call without `true` runs nothing.
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];
