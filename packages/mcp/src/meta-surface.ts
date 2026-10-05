// The META surface: three tools — `list_resources`, `describe_resource`, `manage_resource` — in
// place of one tool per primitive, so `tools/list` stays the same size however many primitives an
// app grows. The catalog, the lazy schemas and the address book live here; the DISPATCH stays in
// `server.ts`, on the same resolve → run → audit path a flat `tools/call` takes, so the three
// security outcomes, the policy inside `invoke` and the synchronous audit line are one code path
// reached through two doors — never a second implementation.
//
// A grouped tool is reachable ONLY through `manage_resource` for a meta caller, and a flat caller
// never sees the meta tools: what `tools/list` shows is what `tools/call` answers, per caller.

import { McpToolDuplicateError } from './errors';
import { assertListParams, listParamsSchema } from './list-params';
import { McpGroupConflictError, McpGroupUnknownError, McpSurfaceInvalidError } from './meta-errors';
import type { AnyMcpTool, McpCaller, ToolListEntry } from './registry';
import { visibleToCaller } from './registry';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

export type McpSurface = 'flat' | 'meta';

/**
 * Which surface a caller is served. A function decides per POPULATION — staff meta, customers flat
 * — from the caller alone, never the arguments. A function that throws or answers anything but the
 * literal `'meta'` serves `'flat'`: the two surfaces reach the same tools under the same gates, so
 * the fallback changes the shape of the catalog, never what the caller may do.
 */
export type McpSurfaceOption = McpSurface | ((caller: McpCaller) => McpSurface);

/** One resource of the meta catalog: a slice or feature, and the tools it answers, by name. */
export interface McpResourceGroup {
  /** What the resource is, for an agent choosing where to look. */
  readonly description: string;
  /** Tool names — a projected action/query or a hand-written tool. One group per tool. */
  readonly tools: readonly string[];
}

/** Resource name → its group. The key is what `manage_resource({ resource })` names. */
export type McpResourceGroups = Readonly<Record<string, McpResourceGroup>>;

export const LIST_RESOURCES = 'list_resources';
export const DESCRIBE_RESOURCE = 'describe_resource';
export const MANAGE_RESOURCE = 'manage_resource';
export const META_TOOL_NAMES: readonly string[] = [
  LIST_RESOURCES,
  DESCRIBE_RESOURCE,
  MANAGE_RESOURCE,
];

/** The three constant entries, as `tools/list` publishes them. */
export const META_TOOL_ENTRIES: readonly ToolListEntry[] = [
  {
    name: DESCRIBE_RESOURCE,
    title: 'Describe resources',
    description:
      "Full input schemas for the actions of one or more resources (batched). Call it before manage_resource when list_resources' one-line params are not enough. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { resources: { type: 'array', items: { type: 'string' } } },
      required: ['resources'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: LIST_RESOURCES,
    title: 'List resources',
    description:
      'The catalog: every resource this caller may use, each with its actions (query or action), a one-line parameter hint and whether a write waits for a human to confirm. Read-only.',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: MANAGE_RESOURCE,
    title: 'Manage a resource',
    description:
      'Run one action of one resource: { resource, action, params }. Same policies, scopes and audit as calling the action directly. Writes may change state or send mail — read the action first.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string' },
        action: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['resource', 'action'],
      additionalProperties: false,
    },
    // The door to every grouped tool, reads and writes alike: a client has to assume the worst of
    // it. `list_resources` says per action which is which.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

export interface MetaAction {
  readonly name: string;
  readonly kind: 'query' | 'action';
  readonly description: string;
  /** One line an agent can compose a call from: `radicado: string, note?: string`. */
  readonly params: string;
  readonly confirms?: true;
  readonly scope?: string;
}

export interface MetaResource {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly MetaAction[];
}

export interface DescribedAction extends Omit<MetaAction, 'params'> {
  readonly inputSchema: JsonSchema;
}

export class MetaSurface {
  readonly #option: McpSurfaceOption;
  readonly #groups: ReadonlyMap<string, McpResourceGroup>;
  /** Tool name → the resource that answers it. */
  readonly #home: ReadonlyMap<string, string>;
  readonly #tools: ReadonlyMap<string, AnyMcpTool>;

  private constructor(
    option: McpSurfaceOption,
    groups: ReadonlyMap<string, McpResourceGroup>,
    home: ReadonlyMap<string, string>,
    tools: ReadonlyMap<string, AnyMcpTool>,
  ) {
    this.#option = option;
    this.#groups = groups;
    this.#home = home;
    this.#tools = tools;
  }

  /**
   * Validate at BOOT and build, or `undefined` for a flat-only server. Every refusal is one an
   * author would otherwise meet as a tool silently missing from, or doubly present in, a catalog.
   */
  static build(input: {
    readonly surface?: McpSurfaceOption | undefined;
    readonly groups?: McpResourceGroups | undefined;
    readonly tools: readonly AnyMcpTool[];
  }): MetaSurface | undefined {
    for (const tool of input.tools) {
      if (tool.listParams !== undefined) {
        assertListParams(tool.name, tool.listParams, tool.inputSchema);
      }
    }
    const option = input.surface ?? 'flat';
    const entries = Object.entries(input.groups ?? {});
    if (option === 'flat') {
      if (entries.length === 0) return undefined;
      throw new McpSurfaceInvalidError({
        cause: `groups: declares ${entries.length} resource(s), and surface is 'flat' for every caller, so no caller would ever see them`,
      });
    }
    if (option !== 'meta' && typeof option !== 'function') {
      throw new McpSurfaceInvalidError({ cause: `surface is ${JSON.stringify(option)}` });
    }
    if (entries.length === 0) {
      throw new McpSurfaceInvalidError({
        cause:
          "surface can be 'meta', and groups: declares no resource, so list_resources would always answer empty",
      });
    }
    const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
    for (const name of META_TOOL_NAMES) {
      if (tools.has(name)) throw new McpToolDuplicateError({ name });
    }
    const home = new Map<string, string>();
    for (const [group, declared] of entries) {
      for (const name of declared.tools) {
        if (!tools.has(name)) {
          throw new McpGroupUnknownError({ group, name, projected: [...tools.keys()].sort() });
        }
        const claimed = home.get(name);
        if (claimed !== undefined) {
          throw new McpGroupConflictError({ name, groups: [claimed, group] });
        }
        home.set(name, group);
      }
    }
    return new MetaSurface(option, new Map(entries), home, tools);
  }

  /** The surface this caller is served. Fail-closed to `'flat'` — see `McpSurfaceOption`. */
  surfaceFor(caller: McpCaller): McpSurface {
    const option = this.#option;
    if (typeof option !== 'function') return option;
    try {
      return option(caller) === 'meta' ? 'meta' : 'flat';
    } catch {
      return 'flat';
    }
  }

  /** True when a META caller must reach this tool through `manage_resource`, not by its name. */
  isGrouped(name: string): boolean {
    return this.#home.has(name);
  }

  /** `list_resources`: only what this caller may see; a resource with nothing visible is absent. */
  listResources(caller: McpCaller): readonly MetaResource[] {
    const out: MetaResource[] = [];
    for (const [name, group] of sorted(this.#groups)) {
      const actions = this.#visibleActions(group, caller).map(
        (tool): MetaAction => ({ ...headOf(tool), params: oneLineParams(schemaOf(tool)) }),
      );
      if (actions.length > 0) out.push({ name, description: group.description, actions });
    }
    return out;
  }

  /**
   * `describe_resource`: the full schemas, or the FIRST name this caller cannot see. Absent and
   * hidden are one answer, exactly as they are for a tool.
   */
  describe(
    names: readonly string[],
    caller: McpCaller,
  ):
    | { readonly ok: true; readonly resources: readonly unknown[] }
    | { readonly ok: false; readonly name: string } {
    const resources: unknown[] = [];
    for (const name of new Set(names)) {
      // A `Map`, so a name like `__proto__` or `constructor` is just a missing key.
      const group = this.#groups.get(name);
      const actions = group === undefined ? [] : this.#visibleActions(group, caller);
      if (group === undefined || actions.length === 0) return { ok: false, name };
      resources.push({
        name,
        description: group.description,
        actions: actions.map(
          (tool): DescribedAction => ({ ...headOf(tool), inputSchema: schemaOf(tool) }),
        ),
      });
    }
    return { ok: true, resources };
  }

  /**
   * The tool `{ resource, action }` addresses, or `undefined` when that pair is not a visible
   * member — the caller then gets the not-found an absent tool gets. Visibility is checked HERE so
   * a hidden tool is never reached; scope, arguments and policy stay with the shared resolver.
   */
  locate(resource: string, action: string, caller: McpCaller): AnyMcpTool | undefined {
    if (this.#home.get(action) !== resource) return undefined;
    const tool = this.#tools.get(action);
    if (tool === undefined || !visibleToCaller(tool, caller)) return undefined;
    return tool;
  }

  #visibleActions(group: McpResourceGroup, caller: McpCaller): readonly AnyMcpTool[] {
    return [...group.tools]
      .sort()
      .map((name) => this.#tools.get(name))
      .filter((tool): tool is AnyMcpTool => tool !== undefined && visibleToCaller(tool, caller));
  }
}

/** The schema a meta call is validated against: the list whitelist when one is declared. */
export function schemaOf(tool: AnyMcpTool): JsonSchema {
  return tool.listParams === undefined
    ? tool.inputSchema
    : listParamsSchema(tool.listParams, tool.inputSchema);
}

/**
 * `list_resources` as the model reads it: PLAIN TEXT, one line per action under one line per
 * resource. The JSON form it answered until 22.10 repeated every key on every action and escaped
 * every quote — a staff catalog measured 32.5k characters — and `JSON.parse` was never its reader's
 * job: the model's is. Same facts, same order; `describe_resource` stays JSON because a schema is.
 *
 * Every per-action tag costs once per action, so each is stated where it is cheapest and still
 * exact (#590): a scope shared by every action of the resource — or of one kind — is said once on
 * the resource line (`hoistScopes`); only `action` is tagged, because untagged means `query` and
 * the header says so. The kind comes from `destructive` (`headOf`), never from the name.
 *
 * ```text
 * cases (scope cases) — Court cases of the account.
 *   listCases {radicado?: string} — List the account's cases.
 *   closeCase (action; confirms) {id: string} — Close a case.
 * ```
 */
export function renderCatalog(resources: readonly MetaResource[]): string {
  if (resources.length === 0) return 'No resources are available to this caller.';
  const lines = [
    `${resources.length} resource(s). Run one with manage_resource({resource, action, params}); describe_resource({resources:["<name>"]}) has the full input schemas. Untagged = read-only query; (action) may write; (confirms) waits for a human; … = more in describe_resource.`,
  ];
  for (const resource of resources) {
    const hoisted = hoistScopes(resource.actions);
    const said = hoisted.line === '' ? '' : ` (${hoisted.line})`;
    lines.push('', `${resource.name}${said} — ${oneLine(resource.description)}`);
    for (const action of resource.actions) {
      const tags = [
        ...(action.kind === 'action' ? ['action'] : []),
        ...(action.confirms === true ? ['confirms'] : []),
        ...(action.scope === undefined || hoisted.kinds.has(action.kind)
          ? []
          : [`scope ${action.scope}`]),
      ];
      const tagged = tags.length === 0 ? '' : ` (${tags.join('; ')})`;
      lines.push(`  ${action.name}${tagged} {${action.params}} — ${oneLine(action.description)}`);
    }
  }
  return lines.join('\n');
}

/**
 * The scopes said once on the resource line, and the kinds whose actions no longer repeat theirs.
 * One scope for every action → `scope cases`. Otherwise per kind, because a token split into
 * `cases:read` / `cases:write` is the common shape: `query scope cases:read; action scope
 * cases:write`. A kind is hoisted only when EVERY action of it carries the SAME scope — one
 * unscoped action among scoped ones must not inherit a gate the registry does not enforce.
 * Computed over what THIS caller sees: the catalog is per caller.
 */
function hoistScopes(actions: readonly MetaAction[]): {
  readonly line: string;
  readonly kinds: ReadonlySet<MetaAction['kind']>;
} {
  const all = sharedScope(actions);
  if (all !== undefined) return { line: `scope ${all}`, kinds: new Set(['query', 'action']) };
  const parts: string[] = [];
  const kinds = new Set<MetaAction['kind']>();
  for (const kind of ['query', 'action'] as const) {
    const scope = sharedScope(actions.filter((action) => action.kind === kind));
    if (scope === undefined) continue;
    parts.push(`${kind} scope ${scope}`);
    kinds.add(kind);
  }
  return { line: parts.join('; '), kinds };
}

/** The scope every action carries, or `undefined` when there is none, one lacks it or two differ. */
function sharedScope(actions: readonly MetaAction[]): string | undefined {
  const first = actions[0]?.scope;
  if (first === undefined) return undefined;
  return actions.every((action) => action.scope === first) ? first : undefined;
}

/** A description authored across lines is still one catalog line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function headOf(tool: AnyMcpTool): Omit<MetaAction, 'params'> {
  return {
    name: tool.name,
    // `=== false`, as `ToolRegistry.verbClass` meters it — one answer per tool. An omitted flag is
    // an action: the header's "untagged = read-only query" holds only for a DECLARED read.
    kind: tool.destructive === false ? 'query' : 'action',
    description: tool.description,
    ...(tool.confirms === true ? { confirms: true } : {}),
    ...(tool.scope === undefined ? {} : { scope: tool.scope }),
  };
}

function sorted<V>(map: ReadonlyMap<string, V>): readonly [string, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Fields a hint names before `…` — every required one is named regardless. */
const HINT_FIELDS = 4;
/** Optional fields stop being added once the hint is this long; required ones never stop. */
const HINT_MAX = 100;
/** Literals an enum hint names before `|…`. */
const HINT_LITERALS = 8;

/**
 * `name: type` per property, `?` when optional, an enum as its literals — the hint
 * `list_resources` carries so a common call needs no `describe_resource` round-trip.
 *
 * Cut by FIELDS, never by characters (#590): a character cut sliced `limit?: integer` into
 * `limit?: i…`. Every required field is named, in declared order, because a call without one
 * fails; optional fields follow until `HINT_FIELDS` names or `HINT_MAX` characters, and a trailing
 * `…` says some were left out. `describe_resource` always has the full schema.
 */
export function oneLineParams(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([key, child]) => ({
    required: required.has(key),
    text: `${key}${required.has(key) ? '' : '?'}: ${typeHint(child)}`,
  }));
  const named = new Set(fields.filter((field) => field.required));
  let length = [...named].reduce((sum, field) => sum + field.text.length + 2, 0);
  for (const field of fields) {
    if (field.required) continue;
    if (named.size >= HINT_FIELDS || length + field.text.length > HINT_MAX) break;
    named.add(field);
    length += field.text.length + 2;
  }
  const parts = fields.filter((field) => named.has(field)).map((field) => field.text);
  return named.size < fields.length ? [...parts, '…'].join(', ') : parts.join(', ');
}

function typeHint(schema: JsonSchema): string {
  if (schema.enum !== undefined) return literals(schema.enum.map((v) => JSON.stringify(v)));
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf !== undefined) return literals(schema.anyOf.map(typeHint));
  if (schema.type === 'array') {
    if (schema.items === undefined) return 'array';
    const item = typeHint(schema.items);
    return item.includes('|') ? `(${item})[]` : `${item}[]`;
  }
  return schema.type ?? 'any';
}

/** A union cut at an alternative, never inside one. */
function literals(alternatives: readonly string[]): string {
  if (alternatives.length <= HINT_LITERALS) return alternatives.join('|');
  return [...alternatives.slice(0, HINT_LITERALS), '…'].join('|');
}
