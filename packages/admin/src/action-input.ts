// An action's input schema, as the form it renders and the posted strings it reads back. The
// schema is the action's own (`t.object({ … })`); this file reads its introspectable node — the
// one IR OpenAPI, MCP and HTTP coercion read — and never writes a second description of it.

import { coerceNode, requiredKeys, type SchemaNode, tryIntrospect } from '@ultimat3/schema';
import { posted } from './form-decode';
import type { AdminAction } from './registry';

/** A posted action input is `input.<property>`: the envelope's own names can never collide. */
export const ACTION_INPUT_PREFIX = 'input.';

/** The control one property of an action's input is drawn as. */
export type ActionInputControl = 'text' | 'number' | 'checkbox' | 'select' | 'datetime' | 'json';

export interface ActionInputField {
  readonly name: string;
  /** `admin.input.<action>.<name>` — beside the action's own label key, never under it. */
  readonly labelKey: string;
  readonly control: ActionInputControl;
  readonly required: boolean;
  /** The closed set of a `select`. */
  readonly values: readonly string[];
  readonly node: SchemaNode;
}

const controlOf = (node: SchemaNode): ActionInputControl => {
  switch (node.kind) {
    case 'string':
      return node.format === 'date-time' ? 'datetime' : 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'enum':
      return 'select';
    case 'date':
      return 'datetime';
    default:
      // An object, a list, a union, money: typed as JSON and judged by the schema.
      return 'json';
  }
};

/**
 * The fields of an action's form, in the schema's own property order. Empty for an action with no
 * input schema and for a schema that is not an introspectable object — such an action's button is
 * a confirm, and its schema still judges whatever a caller sends.
 */
export function actionInputFields(
  action: Pick<AdminAction, 'name' | 'input'>,
): readonly ActionInputField[] {
  const node = tryIntrospect(action.input);
  if (node === undefined || node.kind !== 'object' || node.properties === undefined) return [];
  const required = requiredKeys(node);
  return Object.entries(node.properties).map(([name, property]) => ({
    name,
    // Under `admin.input`, never under the action's own `admin.action.<name>`: a JSON catalog is
    // a tree, so the action's label (a leaf) could not also hold its fields (a branch).
    labelKey: `admin.input.${action.name}.${name}`,
    control: controlOf(property),
    required: required.includes(name),
    values: (property.values ?? []).map(String),
    node: property,
  }));
}

const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Left as typed: the schema names the field, which a thrown SyntaxError would not.
    return raw;
  }
};

/**
 * The posted form → the input the action's schema judges. Converts and never validates: a value
 * that will not convert is passed through as typed, so the schema refuses it in its own words
 * against the field that carried it. An empty box of an optional field is absent, never `''`.
 */
export function decodeActionInput(
  action: Pick<AdminAction, 'name' | 'input'>,
  form: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of actionInputFields(action)) {
    const raw = posted(form, `${ACTION_INPUT_PREFIX}${field.name}`);
    // An unchecked box posts nothing at all, so absence IS the answer for a checkbox.
    if (field.control === 'checkbox') {
      out[field.name] = raw !== undefined && raw !== 'false';
      continue;
    }
    if (raw === undefined || raw === '') {
      if (field.required && field.control === 'text') out[field.name] = '';
      continue;
    }
    if (field.control === 'json') out[field.name] = jsonOf(raw);
    // `datetime-local` posts `YYYY-MM-DDTHH:mm`, and the control says UTC beside the box.
    else if (field.control === 'datetime' && LOCAL_MINUTE.test(raw)) {
      out[field.name] = coerceNode(field.node, `${raw}:00.000Z`);
    } else out[field.name] = coerceNode(field.node, raw);
  }
  return out;
}

/** What a refused form shows again: the strings that were typed, by field. */
export function postedActionInput(
  action: Pick<AdminAction, 'name' | 'input'>,
  form: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const field of actionInputFields(action)) {
    const raw = posted(form, `${ACTION_INPUT_PREFIX}${field.name}`);
    if (raw !== undefined) out[field.name] = raw;
  }
  return out;
}
