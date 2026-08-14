/**
 * A value an input schema accepts, derived from that schema's own IR. The policy contract
 * test needs its invocation to REACH the policy, and `{}` fails `input:` first for every
 * action with a required field — which is how "policy denies an anonymous actor" passed on
 * `X_INPUT_INVALID` and proved nothing about authz.
 */

import type { SchemaFormat, SchemaNode, StandardSchemaV1 } from '@ultimat3/schema';
import { requiredKeys, tryIntrospect } from '@ultimat3/schema';

/** Version 4, variant 1 — the shape `t.uuid` insists on, and no byte of it means anything. */
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

/** Short, and valid under `t.slug`'s and `t.cursor`'s patterns as well as bare `t.string`. */
const SAMPLE_STRING = 'sample';

/**
 * One entry per `SchemaFormat`, exhaustively — a new format is a type error here rather than a
 * silent `'sample'` that fails its own validator and reads as an authz test that cannot pass.
 */
const BY_FORMAT: Readonly<Record<SchemaFormat, string>> = {
  uuid: SAMPLE_UUID,
  email: 'sample@example.test',
  uri: 'https://example.test/sample',
  'date-time': '2020-01-01T00:00:00.000Z',
  slug: SAMPLE_STRING,
  timezone: 'UTC',
  locale: 'en',
  cursor: SAMPLE_STRING,
};

function sampleString(node: SchemaNode): string {
  if (node.format !== undefined) {
    // A format value is already the exact shape its validator wants; padding or truncating it
    // to a length bound would break the only thing that makes it valid.
    const known: string | undefined = BY_FORMAT[node.format];
    return known ?? SAMPLE_STRING;
  }
  const min = node.minLength ?? 0;
  const padded = SAMPLE_STRING.length >= min ? SAMPLE_STRING : SAMPLE_STRING.padEnd(min, 'x');
  return node.maxLength === undefined ? padded : padded.slice(0, node.maxLength);
}

function sampleNumber(node: SchemaNode): number {
  const low = node.minimum ?? 0;
  const value = node.integer === true ? Math.ceil(low) : low;
  if (node.maximum === undefined || value <= node.maximum) return value;
  return node.integer === true ? Math.floor(node.maximum) : node.maximum;
}

function sampleObject(node: SchemaNode): Record<string, unknown> {
  const properties = node.properties ?? {};
  const sample: Record<string, unknown> = {};
  // Required-only is what "minimal" means: an optional key and a defaulted one are both
  // absences the schema already accepts, so adding them would only widen what can go wrong.
  for (const key of requiredKeys(node)) {
    const child = properties[key];
    if (child !== undefined) sample[key] = sampleFor(child);
  }
  return sample;
}

function sampleFor(node: SchemaNode): unknown {
  // A nullable field accepts `null`, and `null` is the smallest thing it accepts.
  if (node.nullable === true) return null;
  switch (node.kind) {
    case 'string':
      return sampleString(node);
    case 'number':
      return sampleNumber(node);
    case 'boolean':
      return false;
    case 'date':
      return BY_FORMAT['date-time'];
    case 'enum':
      return node.values?.[0] ?? SAMPLE_STRING;
    case 'literal':
      return node.literal ?? null;
    case 'array':
      return [];
    case 'union': {
      const first = node.anyOf?.[0];
      return first === undefined ? null : sampleFor(first);
    }
    case 'record':
      return {};
    case 'money':
      return { minor: 0, currency: 'USD' };
    case 'object':
      return sampleObject(node);
    default:
      // `unknown`, and any kind a third-party provider emits that this build has never heard
      // of. Deliberately not `assertNever`: a swapped schema provider must not turn a
      // generated contract test into a crash, and the caller already reports a rejected
      // sample as drift with the instruction to pass the input itself.
      return null;
  }
}

/**
 * Best effort, and honest about it: a schema carrying a constraint the IR does not — a bare
 * `pattern`, a provider's own refinement — yields a value the schema rejects. The caller turns
 * that into `X_CONTRACT_DRIFT` naming `input:` as the fix, because a silently skipped assertion
 * is the vacuous test this function exists to end.
 */
export function sampleInput(schema: StandardSchemaV1): unknown {
  const node = tryIntrospect(schema);
  return node === undefined ? {} : sampleFor(node);
}
