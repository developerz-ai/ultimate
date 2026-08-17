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

/**
 * SHA-256, first 16 hex characters — the same primitive and width `@ultimat3/query`'s `fingerprint`
 * and `@ultimat3/realtime`'s `stableDigest` already chose, and for the same reason.
 *
 * A fingerprint here is a SHARING key over input a client chooses, not a checksum. It is the
 * `requestHash` that decides "same request, replay the stored response" and the job dedupe key
 * `job-handle.ts` files an enqueue under, so a collision hands one caller's stored response to a
 * different request, or drops an enqueue as a duplicate of a job it shares nothing with. FNV-1a/32
 * — what this was — is 4x10^9 values, brute-forceable offline in seconds, so a payload landing on
 * another request's hash was something an attacker could mint rather than something they had to
 * wait for.
 *
 * The canonical form above is unchanged, so the only thing that moved is the hash: an idempotency
 * record reserved before this deploy answers a retry as a payload mismatch
 * (`X_IDEMPOTENCY_CONFLICT`), whose fix — send a fresh key — is the right instruction.
 */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}
