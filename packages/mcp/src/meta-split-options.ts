// `split:` — what an app adds to the `'meta-split'` dispatchers: string fields of its own on their
// envelopes (a `reason`, a change ticket), and a `stricter` hook that sends one call to
// `delete_resource` by its arguments.
//
// A field belongs to the CALL, never to the action: it is validated on the envelope and handed on
// as `caller.door.fields`, so no action input ever carries it. Boot check and the published
// entries here; the dispatch is `meta-split-call.ts`.

import { renderCauseValue } from '@ultimat3/core';
import { McpSplitInvalidError } from './meta-errors';
import type { McpEffectClass } from './meta-split';
import { SPLIT_DISPATCHERS, SPLIT_TOOL_ENTRIES } from './meta-split';
import type { McpCaller, ToolArgs, ToolListEntry } from './registry';
import type { JsonSchema } from './wire';

/** One of `read_resource`, `write_resource`, `delete_resource`. */
export type McpSplitDispatcher = 'read_resource' | 'write_resource' | 'delete_resource';

/** One app-declared string field of a dispatcher envelope. */
export interface McpSplitField {
  /** What the field is for. Published by `tools/list`; an agent reads only this. */
  readonly description: string;
  /** The dispatchers that take it. Absent: all three. */
  readonly tools?: readonly McpSplitDispatcher[];
  /** A call through those dispatchers without it is refused as invalid arguments. Default `false`. */
  readonly required?: boolean;
  /** The longest value accepted. */
  readonly maxLength?: number;
}

/** One call, as the `stricter` hook is asked about it: located, in scope, valid, admitted. */
export interface McpSplitCall {
  readonly caller: McpCaller;
  /** The dispatcher the call came through. */
  readonly tool: string;
  readonly resource: string;
  readonly action: string;
  /** What the action is: a read, or its declared effect. */
  readonly effect: McpEffectClass;
  /** The action's parameters, validated against its schema. */
  readonly params: ToolArgs;
  /** The declared envelope fields this call carried. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface McpSplitOptions {
  /** Field name → its declaration. A name the envelope already owns is refused at boot. */
  readonly fields?: Readonly<Record<string, McpSplitField>>;
  /**
   * Whether THIS call must come through `delete_resource`, where it previews unless `live: true`
   * and commits only with `confirmed_by_user: true`. Asked for a read on `read_resource` and a
   * write on `write_resource` — demanded there, the call is refused `X_MCP_WRONG_TOOL` naming
   * `delete_resource` and nothing runs — and for a read on `delete_resource`, which runs there
   * only when demanded. Fail-closed: anything but the literal `false` demands it, and a throw
   * fails the call. A write may always come through `delete_resource`; nothing widens
   * `write_resource` or `read_resource`.
   */
  readonly stricter?: (call: McpSplitCall) => boolean | Promise<boolean>;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** What the envelopes already mean by these names. */
const OWNED: readonly string[] = [
  'resource',
  'action',
  'params',
  'live',
  'confirmed_by_user',
  // A plain name by the pattern, and never a key: assigning it sets a prototype.
  '__proto__',
];

/** Boot: the options can be served, and every field is a plain name the envelope does not own. */
export function assertSplit(split: McpSplitOptions, canSplit: boolean): void {
  const refuse = (cause: string): never => {
    throw new McpSplitInvalidError({ cause });
  };
  if (!canSplit) {
    refuse(
      "split: is declared, and surface is never 'meta-split', so no caller is served a dispatcher",
    );
  }
  const stricter: unknown = split.stricter;
  if (stricter !== undefined && typeof stricter !== 'function') {
    refuse(`split.stricter is ${renderCauseValue(stricter)}, and it has to be a function`);
  }
  for (const [name, field] of Object.entries(split.fields ?? {})) {
    const shown = renderCauseValue(name);
    if (!FIELD_NAME.test(name) || OWNED.includes(name)) {
      refuse(
        `split.fields names ${shown}, which is not a plain argument name, or is one the dispatcher envelope already owns`,
      );
    }
    const declared: Partial<McpSplitField> = field ?? {};
    if (typeof declared.description !== 'string' || declared.description.trim() === '') {
      refuse(`split.fields[${shown}] has no description, and an agent reads only that`);
    }
    const tools: unknown = declared.tools ?? SPLIT_DISPATCHERS;
    if (!Array.isArray(tools)) {
      refuse(`split.fields[${shown}].tools is ${renderCauseValue(tools)}, and it has to be a list`);
    }
    for (const tool of tools as readonly unknown[]) {
      if (typeof tool !== 'string' || !SPLIT_DISPATCHERS.includes(tool)) {
        refuse(
          `split.fields[${shown}].tools names ${renderCauseValue(tool)}, which is not a dispatcher`,
        );
      }
    }
    const max: unknown = declared.maxLength;
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1)) {
      refuse(
        `split.fields[${shown}].maxLength is ${renderCauseValue(max)}, and it has to be a positive integer`,
      );
    }
  }
}

/** The fields `dispatcher` takes, in declaration order. */
function fieldsFor(
  split: McpSplitOptions,
  dispatcher: string,
): readonly (readonly [string, McpSplitField])[] {
  return Object.entries(split.fields ?? {}).filter(
    ([, field]) => field.tools === undefined || field.tools.some((tool) => tool === dispatcher),
  );
}

/** The three dispatchers as THIS server publishes them: the constant entries plus its fields. */
export function splitEntries(split: McpSplitOptions | undefined): readonly ToolListEntry[] {
  if (split?.fields === undefined) return SPLIT_TOOL_ENTRIES;
  return SPLIT_TOOL_ENTRIES.map((entry) => {
    const fields = fieldsFor(split, entry.name);
    if (fields.length === 0) return entry;
    const properties: Record<string, JsonSchema> = { ...entry.inputSchema.properties };
    for (const [name, field] of fields) {
      const value: JsonSchema = {
        type: 'string',
        description: field.description,
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      };
      Object.defineProperty(properties, name, { value, enumerable: true });
    }
    const required = fields.filter(([, field]) => field.required === true).map(([name]) => name);
    return {
      ...entry,
      inputSchema: {
        ...entry.inputSchema,
        properties,
        required: [...(entry.inputSchema.required ?? []), ...required],
      },
    };
  });
}

/** The declared fields one validated envelope carried — what `caller.door.fields` holds. */
export function fieldsOf(
  split: McpSplitOptions | undefined,
  dispatcher: string,
  args: ToolArgs,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (split === undefined) return out;
  for (const [name] of fieldsFor(split, dispatcher)) {
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
    if (typeof value === 'string') Object.defineProperty(out, name, { value, enumerable: true });
  }
  return out;
}

/**
 * Ask the hook. Anything but the literal `false` demands the stricter door: a hook that forgets
 * to answer must not be the one that lets a call through the lighter one.
 */
export async function demandsStricter(
  split: McpSplitOptions | undefined,
  call: McpSplitCall,
): Promise<boolean> {
  if (split?.stricter === undefined) return false;
  return (await split.stricter(call)) !== false;
}
