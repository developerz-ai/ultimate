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
    case 'boolean': {
      if (typeof raw !== 'string') return raw;
      const lowered = raw.toLowerCase();
      if (TRUE_VALUES.has(lowered)) return true;
      if (FALSE_VALUES.has(lowered)) return false;
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
      const out: Record<string, unknown> = {};
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
        if (key in source) out[key] = coerceNode(child, source[key]);
      }
      return out;
    }
    case 'money': {
      if (typeof raw !== 'object') return raw;
      const source = raw as Record<string, unknown>;
      const minor = typeof source['minor'] === 'string' ? Number(source['minor']) : source['minor'];
      if (!Number.isFinite(minor)) return raw;
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

function toRecord(source: QuerySource): Record<string, string | readonly string[] | undefined> {
  if (!(source instanceof URLSearchParams)) {
    return { ...source };
  }
  const out: Record<string, string | readonly string[]> = {};
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
    if (!(key in record)) continue;
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
