// Single responsibility: the two readers of `.sensitive()` — the mask a walker that holds a schema
// applies before writing a value down, and the refusal of a flag reachable from an output. Its own
// file so `t`, which is in every bundle graph, carries neither.

import { SensitiveOutputError } from './errors';
import { isSchemaNode, type SchemaNode } from './node';
import { tryIntrospect } from './provider';

/** Whether anything under a node is flagged. Memoised per node: an unflagged action pays one read. */
const flagged = new WeakMap<SchemaNode, boolean>();

function children(node: SchemaNode): readonly SchemaNode[] {
  return [
    ...Object.values(node.properties ?? {}),
    ...(node.items === undefined ? [] : [node.items]),
    ...(node.valueNode === undefined ? [] : [node.valueNode]),
    ...(node.anyOf ?? []),
  ];
}

function holdsSensitive(node: SchemaNode): boolean {
  const known = flagged.get(node);
  if (known !== undefined) return known;
  // Seeded false before the walk, so a node graph that reaches itself terminates.
  flagged.set(node, false);
  const answer = node.sensitive === true || children(node).some(holdsSensitive);
  flagged.set(node, answer);
  return answer;
}

function nodeFor(schema: unknown): SchemaNode | undefined {
  if (isSchemaNode(schema)) return schema;
  try {
    return tryIntrospect(schema);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A shallow copy with the masked keys replaced — `defineProperty`, so `__proto__` stays a key. */
function withKeys(value: Record<string, unknown>, masked: ReadonlyMap<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, held] of Object.entries(value)) {
    Object.defineProperty(out, name, {
      value: masked.has(name) ? masked.get(name) : held,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function maskRecord(node: SchemaNode, value: Record<string, unknown>, replacement: string) {
  const masked = new Map<string, unknown>();
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (holdsSensitive(child) && Object.hasOwn(value, key)) {
      masked.set(key, mask(child, value[key], replacement));
    }
  }
  const entries = node.valueNode;
  if (entries !== undefined && holdsSensitive(entries)) {
    for (const [key, entry] of Object.entries(value)) {
      masked.set(key, mask(entries, masked.has(key) ? masked.get(key) : entry, replacement));
    }
  }
  return masked.size === 0 ? value : withKeys(value, masked);
}

function mask(node: SchemaNode, value: unknown, replacement: string): unknown {
  if (!holdsSensitive(node) || value === undefined) return value;
  if (node.sensitive === true) return replacement;
  let out: unknown = value;
  if (isRecord(out)) out = maskRecord(node, out, replacement);
  const items = node.items;
  if (items !== undefined && Array.isArray(out)) {
    out = out.map((entry: unknown) => mask(items, entry, replacement));
  }
  // Every branch's mask, in turn, and no branch resolution: a value the walker misreads as the
  // wrong branch must still lose the keys the right one flags. Fail closed.
  for (const branch of node.anyOf ?? []) out = mask(branch, out, replacement);
  return out;
}

/**
 * `value` with every `.sensitive()` field `schema` reaches replaced by `replacement` — a copy,
 * never an edit. The same reference back when nothing is flagged (or nothing can describe the
 * schema), so the walk costs an unflagged action one map read.
 *
 * Reach: what the framework writes down from a value it holds WITH its schema — the audit record,
 * `x jobs show`. Not an app's own log line: that carries no schema, and stays `redactKeys`.
 */
export function maskSensitive(schema: unknown, value: unknown, replacement: string): unknown {
  const node = nodeFor(schema);
  return node === undefined ? value : mask(node, value, replacement);
}

function sensitivePath(node: SchemaNode, at: string): string | undefined {
  if (!holdsSensitive(node)) return undefined;
  if (node.sensitive === true) return at;
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const found = sensitivePath(child, at === '' ? key : `${at}.${key}`);
    if (found !== undefined) return found;
  }
  const nested = [
    ...(node.items === undefined ? [] : [[node.items, `${at}[]`] as const]),
    ...(node.valueNode === undefined ? [] : [[node.valueNode, `${at}{}`] as const]),
    ...(node.anyOf ?? []).map((branch) => [branch, at] as const),
  ];
  for (const [child, path] of nested) {
    const found = sensitivePath(child, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Refuse a `.sensitive()` field reachable from an output — an action's `output`, a query's
 * `rows`. An output leaves the server, which `writeOnly` forbids. A schema nothing can describe is
 * passed: the check reads the IR, and a provider without one has no flag to find.
 */
export function assertNoSensitiveOutput(owner: string, schema: unknown): void {
  const node = nodeFor(schema);
  if (node === undefined) return;
  const path = sensitivePath(node, '');
  if (path === undefined) return;
  const at = path === '' ? '(the root)' : path;
  throw new SensitiveOutputError({
    cause: `${owner} reaches the .sensitive() field ${at}, and an output is sent back to the caller`,
    fix: `x verify   # after deleting .sensitive() at ${at} in ${owner}, or dropping that field from the output`,
    meta: { owner, path: at },
  });
}
