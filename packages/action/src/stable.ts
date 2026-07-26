/**
 * Deterministic JSON: key-sorted serialization plus a cheap content hash.
 * Both the OpenAPI document and idempotency fingerprints depend on byte-stable
 * output, so this is the only serializer either path is allowed to use.
 */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth. No timestamps, no insertion-order leaks. */
export function stableStringify(value: unknown, indent = 0): string {
  return write(value, indent, 0);
}

function write(value: unknown, indent: number, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return String(value);
    case 'bigint':
      return JSON.stringify(`${value}n`);
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  const pad = indent > 0 ? '\n'.padEnd(1 + indent * (depth + 1), ' ') : '';
  const close = indent > 0 ? '\n'.padEnd(1 + indent * depth, ' ') : '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => write(item, indent, depth + 1));
    return `[${pad}${items.join(`,${pad || ''}`)}${close}]`;
  }
  const record = value as JsonObject;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const gap = indent > 0 ? ' ' : '';
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${gap}${write(record[key], indent, depth + 1)}`,
  );
  return `{${pad}${entries.join(`,${pad || ''}`)}${close}}`;
}

/** FNV-1a/32 as hex. Fingerprinting only — never a security boundary. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Stable fingerprint of any JSON-ish value. */
export function fingerprint(value: unknown): string {
  return fnv1a(stableStringify(value));
}
