// Single responsibility: HTTP-boundary coercion. Kept out of validation on purpose — only the
// HTTP layer has strings that "mean" numbers. Actions, jobs and MCP calls receive real JSON and
// must never get this leniency.

import type { SchemaNode } from './node';
import { tryIntrospect } from './provider';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

/** A numeric string as a number, or `undefined` for anything that is not confidently one. */
function numeric(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** A truthy/falsy query-string spelling as a boolean, or the raw value when it is neither. */
function booleanish(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const lowered = raw.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return true;
  if (FALSE_VALUES.has(lowered)) return false;
  return raw;
}

export type QuerySource =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Coerce one raw value toward `node`. Never throws and never invents data: anything it cannot
 * confidently convert is returned untouched so validation produces the real error message.
 */
export function coerceNode(node: SchemaNode, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;

  switch (node.kind) {
    case 'number': {
      if (typeof raw !== 'string') return raw;
      const value = Number(raw);
      return raw.trim() !== '' && Number.isFinite(value) ? value : raw;
    }
    case 'boolean':
      return booleanish(raw);
    case 'literal': {
      // Toward the literal's OWN type, because `literalSchema` compares with `===`: without this
      // a numeric or boolean `t.literal` was unsatisfiable over its own GET route — `t.literal(2)`
      // received `"2"` and the endpoint 400d on every request — while the identical declaration
      // worked over an action's JSON body and over MCP. A string literal needs nothing, which is
      // exactly why the gap read as arbitrary.
      if (typeof raw !== 'string') return raw;
      if (typeof node.literal === 'number') return numeric(raw) ?? raw;
      if (typeof node.literal === 'boolean') return booleanish(raw);
      return raw;
    }
    case 'date': {
      if (typeof raw !== 'string') return raw;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? raw : parsed;
    }
    case 'array': {
      const items: unknown[] = Array.isArray(raw) ? raw : [raw];
      const itemNode = node.items;
      return itemNode === undefined ? items : items.map((item) => coerceNode(itemNode, item));
    }
    case 'record': {
      if (typeof raw !== 'object' || node.valueNode === undefined) return raw;
      // A null prototype for the reason `recordSchema` uses one: on a `{}` literal, assigning
      // `out['__proto__']` hits the `Object.prototype` SETTER and the key vanishes, so the
      // record validator's deliberate refusal of it never ran — the key was reported absent
      // rather than rejected, on the one path (HTTP query) where it is caller-controlled.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        out[key] = coerceNode(node.valueNode, value);
      }
      return out;
    }
    case 'object': {
      if (typeof raw !== 'object' || node.properties === undefined) return raw;
      const source = raw as Record<string, unknown>;
      const out: Record<string, unknown> = { ...source };
      for (const [key, child] of Object.entries(node.properties)) {
        // `Object.hasOwn`, never `key in source`: `{ ...source }` above already dropped what a
        // prototype carries, so an `in` check put it back — a schema field named `toString` or
        // `valueOf` was coerced from the INHERITED member and handed validation a function.
        if (Object.hasOwn(source, key)) out[key] = coerceNode(child, source[key]);
      }
      return out;
    }
    case 'money': {
      if (typeof raw !== 'object') return raw;
      const source = raw as Record<string, unknown>;
      // Through `numeric` for the same reason `scale` is: `Number('')` is 0, so a blank amount
      // field converted here would reach the validator as a legitimate zero and book an empty
      // price input as free. A blank stays a blank and fails validation, which is the real error.
      const rawMinor = source['minor'];
      const minor = typeof rawMinor === 'string' ? numeric(rawMinor) : rawMinor;
      if (typeof minor !== 'number' || !Number.isFinite(minor)) return raw;
      // `scale` arrives as text from a query string exactly as `minor` does. Left a string it
      // would fail validation on a value whose `minor` the same request just had converted.
      const scale = numeric(source['scale']);
      return { ...source, minor, ...(scale === undefined ? {} : { scale }) };
    }
    case 'union': {
      // Only unambiguous single-kind unions (e.g. `number | undefined`) are safe to coerce.
      const kinds = new Set((node.anyOf ?? []).map((member) => member.kind));
      if (kinds.size !== 1) return raw;
      const [member] = node.anyOf ?? [];
      return member === undefined ? raw : coerceNode(member, raw);
    }
    default:
      return raw;
  }
}

/**
 * `Object.create(null)`, for the reason `@ultimat3/http`'s `parseQuery` already uses one: this
 * record is built from caller-controlled keys. On a `{}` literal `out['__proto__'] = …` hits the
 * prototype accessor instead of declaring a key, and every member of `Object.prototype` reads
 * back as present when the client sent nothing.
 */
function toRecord(source: QuerySource): Record<string, string | readonly string[] | undefined> {
  const out = Object.create(null) as Record<string, string | readonly string[] | undefined>;
  if (!(source instanceof URLSearchParams)) {
    return Object.assign(out, source);
  }
  for (const key of new Set(source.keys())) {
    const all = source.getAll(key);
    out[key] = all.length > 1 ? all : (all[0] as string);
  }
  return out;
}

/**
 * Coerce a query string / route params object against a schema, ready to `parse()`.
 * Unknown keys are passed through — the schema decides what to keep.
 */
export function coerceQuery(schema: unknown, source: QuerySource): Record<string, unknown> {
  const record = toRecord(source);
  const node = tryIntrospect(schema);
  if (node?.properties === undefined) return record;

  const out: Record<string, unknown> = { ...record };
  for (const [key, child] of Object.entries(node.properties)) {
    // See `toRecord`: a declared property is coerced only when the caller actually sent it.
    if (!Object.hasOwn(record, key)) continue;
    const raw = record[key];
    out[key] = coerceNode(child, child.kind === 'array' ? (raw ?? []) : normaliseSingle(raw));
  }
  return out;
}

function normaliseSingle(raw: string | readonly string[] | undefined): unknown {
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

/** Coerce an arbitrary record (route params, form data) against a schema. */
export function coerceInput(
  schema: unknown,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const node = tryIntrospect(schema);
  if (node === undefined) return { ...raw };
  const coerced = coerceNode(node, raw);
  return typeof coerced === 'object' && coerced !== null
    ? (coerced as Record<string, unknown>)
    : { ...raw };
}
