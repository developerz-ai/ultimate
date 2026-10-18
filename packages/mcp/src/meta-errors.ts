// The boot-time refusals of the META surface (`surface: 'meta'` + `groups:` in `defineAppMcp`).
// Codes and titles are registered in `errors.ts` with the rest of the package's; these classes
// sit apart only so that file stays under the size ceiling.

import { UltimateError } from '@ultimat3/core';

/**
 * The one instruction safe on both branches of outcome 1 for a META caller — the twin of
 * `TOOL_UNKNOWN_FIX`. Every not-found a meta caller receives carries THIS sentence, grouped name or
 * flat, absent or hidden: a second wording for one branch would be the oracle outcome 1 removes.
 */
export const META_UNKNOWN_FIX =
  'call tools/list and list_resources to read the catalog this caller may use';

/** `groups:` names a tool no projected or hand-written tool answers to. */
export class McpGroupUnknownError extends UltimateError {
  readonly projected: readonly string[];

  constructor(input: { group: string; name: string; projected: readonly string[] }) {
    const projected = input.projected.length > 0 ? input.projected.join(', ') : 'nothing';
    super({
      code: 'X_MCP_GROUP_UNKNOWN',
      cause: `groups["${input.group}"] names "${input.name}", which this server does not project (projected: ${projected})`,
      fix: `in defineAppMcp, spell it as one of the projected names above — or drop "${input.name}" from groups["${input.group}"].tools`,
    });
    this.projected = input.projected;
  }
}

/**
 * One tool claimed by two groups. `manage_resource` addresses a tool as `{ resource, action }`, so
 * a tool in two resources has two addresses — and which one `list_resources` shows would be
 * decided by object key order.
 */
export class McpGroupConflictError extends UltimateError {
  readonly groups: readonly [string, string];

  constructor(input: { name: string; groups: readonly [string, string] }) {
    super({
      code: 'X_MCP_GROUP_CONFLICT',
      cause: `tool "${input.name}" is listed in two groups ("${input.groups[0]}" and "${input.groups[1]}"); a tool belongs to one resource`,
      fix: `in defineAppMcp, keep "${input.name}" in the one group an agent should find it under, and remove the other entry`,
    });
    this.groups = input.groups;
  }
}

/** A `listParams` key the tool's own input does not declare — a promise the query never keeps. */
export class McpListParamsInvalidError extends UltimateError {
  constructor(input: { name: string; key: string }) {
    super({
      code: 'X_MCP_LIST_PARAMS_INVALID',
      cause: `tool "${input.name}" whitelists "${input.key}" in listParams, and its input schema does not declare "${input.key}" — the query would never read it`,
      fix: `add "${input.key}" to the input of "${input.name}" (the query implements it), or drop it from mcp.listParams`,
    });
  }
}

/** `surface` and `groups` disagree: a meta surface with nothing behind it, or groups nobody sees. */
export class McpSurfaceInvalidError extends UltimateError {
  constructor(input: { cause: string }) {
    super({
      code: 'X_MCP_SURFACE_INVALID',
      cause: input.cause,
      fix: "in defineAppMcp, declare groups: { <resource>: { description, tools: [...] } } together with surface: 'meta' (or surface: (caller) => 'meta' | 'flat'), or drop both",
    });
  }
}

/** A grouped write on a `'meta-split'` surface that names no effect: no dispatcher can run it. */
export class McpEffectUndeclaredError extends UltimateError {
  readonly names: readonly string[];

  constructor(input: { names: readonly string[] }) {
    const names = input.names.join(', ');
    super({
      code: 'X_MCP_EFFECT_UNDECLARED',
      cause: `surface can be 'meta-split', and ${input.names.length} grouped write(s) declare no effect (${names}), so neither write_resource nor delete_resource can be picked for them`,
      fix: `mcp: { expose: true, effect: 'write' }   # on ${names} — 'delete' for an archive, a cancel, a send or a spend; a hand-written tool takes tools: { <name>: { effect } }`,
    });
    this.names = input.names;
  }
}

/** A grouped READ that declares an effect: a read is `read_resource`'s, whatever it says. */
export class McpEffectConflictError extends UltimateError {
  constructor(input: { name: string; effect: string }) {
    super({
      code: 'X_MCP_EFFECT_CONFLICT',
      cause: `"${input.name}" is a read (a query, or destructive: false) and declares effect: '${input.effect}'; on a meta-split surface a read is always run by read_resource`,
      fix: `mcp: { expose: true }   # on "${input.name}", without effect — or, if it changes state, make it an action (or a tool with destructive: true) and keep effect: '${input.effect}'`,
    });
  }
}

/** The right action, the wrong dispatcher. Names the dispatcher that runs it; nothing ran. */
export class McpWrongToolError extends UltimateError {
  readonly useTool: string;

  constructor(input: { resource: string; action: string; called: string; useTool: string }) {
    const call = `${input.useTool}({ resource: "${input.resource}", action: "${input.action}", params })`;
    super({
      code: 'X_MCP_WRONG_TOOL',
      cause: `${input.resource}.${input.action} is not run by ${input.called}; it is run by ${input.useTool} (wrong_tool_for_action). Nothing ran`,
      fix: `${call}   # the same params, on ${input.useTool}`,
      callerFix: `call ${call} with the same params`,
      meta: {
        resource: input.resource,
        action: input.action,
        called: input.called,
        use_tool: input.useTool,
      },
    });
    this.useTool = input.useTool;
  }
}

/** A `delete_resource` commit (`live: true`) without the user's approval. Nothing ran. */
export class McpUserConfirmationRequiredError extends UltimateError {
  constructor(input: { resource: string; action: string }) {
    const call = `delete_resource({ resource: "${input.resource}", action: "${input.action}", params, live: true, confirmed_by_user: true })`;
    super({
      code: 'X_MCP_USER_CONFIRMATION_REQUIRED',
      cause: `${input.resource}.${input.action} commits only with confirmed_by_user: true; nothing ran`,
      fix: `${call}   # once the user approved this change, directly or by authorizing the task that includes it; live: false previews it without running`,
      callerFix: `ask the user to approve ${input.resource}.${input.action}, then call ${call} with the same params`,
      meta: {
        resource: input.resource,
        action: input.action,
        retry_with: { confirmed_by_user: true },
      },
    });
  }
}
