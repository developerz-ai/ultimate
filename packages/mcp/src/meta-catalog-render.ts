// `list_resources` as text: the full catalog (one line per action, with its parameter hint) or the
// compact one an app picks with `catalogDetail: 'compact'` (action names and tags, the rest in
// `describe_resource`). Split from ./meta-surface (the catalog's data and boot checks) at its
// line ceiling.

import type { MetaAction, MetaResource } from './meta-surface';
import type { JsonSchema } from './wire';

/**
 * How much of each action `list_resources` says. `'full'` (the default): description and a
 * one-line parameter hint per action. `'compact'`: names and tags only — for a catalog whose full
 * listing outgrows a model's turn; `describe_resource` answers the rest per resource.
 */
export type McpCatalogDetail = 'full' | 'compact';

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
 *
 * `'meta-split'` tags a write with the tool that runs it instead — `(write)` or `(delete)` — and
 * its header names the three dispatchers; untagged still means a read.
 */
export function renderCatalog(
  resources: readonly MetaResource[],
  surface: 'meta' | 'meta-split' = 'meta',
  detail: McpCatalogDetail = 'full',
): string {
  if (resources.length === 0) return 'No resources are available to this caller.';
  const header = surface === 'meta' ? metaHeader(resources.length) : splitHeader(resources.length);
  const lines = [detail === 'compact' ? `${header} ${COMPACT_NOTE}` : header];
  for (const resource of resources) {
    const hoisted = hoistScopes(resource.actions);
    const said = hoisted.line === '' ? '' : ` (${hoisted.line})`;
    lines.push('', `${resource.name}${said} — ${oneLine(resource.description)}`);
    const named = resource.actions.map((action) => {
      const kind =
        action.kind === 'action'
          ? surface === 'meta'
            ? 'action'
            : (action.effect ?? 'action')
          : '';
      const rest = [
        ...(action.confirms === true ? ['confirms'] : []),
        ...(action.scope === undefined || hoisted.kinds.has(action.kind)
          ? []
          : [`scope ${action.scope}`]),
      ];
      return { action, kind, rest };
    });
    if (detail === 'compact') {
      lines.push(`  ${compactLine(named)}`);
      continue;
    }
    for (const { action, kind, rest } of named) {
      const tags = [...(kind === '' ? [] : [kind]), ...rest];
      const tagged = tags.length === 0 ? '' : ` (${tags.join('; ')})`;
      lines.push(`  ${action.name}${tagged} {${action.params}} — ${oneLine(action.description)}`);
    }
  }
  return lines.join('\n');
}

/**
 * One resource's actions on one line, grouped by the kind tag each would carry — reads untagged,
 * then `action:` (or `write:` / `delete:`) once per group — so a tag is said once per resource, not
 * once per action. The tags that differ per action (`confirms`, an unhoisted scope) stay on it.
 */
function compactLine(
  named: readonly {
    readonly action: MetaAction;
    readonly kind: string;
    readonly rest: readonly string[];
  }[],
): string {
  const groups: string[] = [];
  for (const kind of ['', 'action', 'write', 'delete']) {
    const members = named
      .filter((one) => one.kind === kind)
      .map((one) =>
        one.rest.length === 0 ? one.action.name : `${one.action.name} (${one.rest.join('; ')})`,
      );
    if (members.length === 0) continue;
    groups.push(kind === '' ? members.join(', ') : `${kind}: ${members.join(', ')}`);
  }
  return groups.join('; ');
}

const COMPACT_NOTE =
  'Names only: a tag before a colon (action: …) tags every name after it on that line. Each action\'s description and parameters are in describe_resource({resources:["<name>"]}) — read it before the first call to a resource.';

const metaHeader = (count: number): string =>
  `${count} resource(s). Run one with manage_resource({resource, action, params}); describe_resource({resources:["<name>"]}) has the full input schemas. Untagged = read-only query; (action) may write; (confirms) waits for a human; … = more in describe_resource.`;

const splitHeader = (count: number): string =>
  `${count} resource(s). Untagged = read-only, run with read_resource({resource, action, params}); (write) runs with write_resource({resource, action, params}); (delete) archives, sends or spends, run with delete_resource({resource, action, params, live, confirmed_by_user}) — live: false previews it. describe_resource({resources:["<name>"]}) has the full input schemas. (confirms) waits for a human; … = more in describe_resource.`;

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
