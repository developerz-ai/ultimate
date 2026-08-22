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
    // `Object.hasOwn`, never the read alone: `node.format` comes from a provider's IR, and
    // `BY_FORMAT['constructor']` is the `Object` function off the prototype chain rather than
    // `undefined` — a function in the payload the policy assertion invokes with, where the type
    // says `string`. Same discriminator `naming.ts` uses on its irregular-plural table.
    const known = Object.hasOwn(BY_FORMAT, node.format) ? BY_FORMAT[node.format] : undefined;
    return known ?? SAMPLE_STRING;
  }
  const min = node.minLength ?? 0;
  const padded = SAMPLE_STRING.length >= min ? SAMPLE_STRING : SAMPLE_STRING.padEnd(min, 'x');
  return node.maxLength === undefined ? padded : padded.slice(0, node.maxLength);
}

/**
 * Whether the value this module built for `node` satisfies the node's own `pattern`.
 *
 * A regex cannot be inverted, so `sampleString` cannot construct a value for an arbitrary one —
 * but `pattern` IS in the IR, so whether the value it DID construct is acceptable is knowable
 * here, before the sample is ever handed to `invoke`. That is the whole difference between
 * "the framework could not build your payload, pass one" and an `X_INPUT_INVALID` surfacing out
 * of the action's own parse, which reads as the action being wrong when the action is fine.
 *
 * An uncompilable pattern is a gap, not a throw: only a foreign provider's IR can produce one
 * (`t.string.pattern()` takes a `RegExp`, whose `.source` always recompiles), and a generated
 * contract test must not die on the way to reporting what it needs.
 */
function satisfiesPattern(node: SchemaNode, value: unknown): boolean {
  if (node.pattern === undefined) return true;
  if (typeof value !== 'string') return false;
  try {
    return new RegExp(node.pattern, node.patternFlags ?? '').test(value);
  } catch {
    return false;
  }
}

function sampleNumber(node: SchemaNode): number {
  const low = node.minimum ?? 0;
  const value = node.integer === true ? Math.ceil(low) : low;
  if (node.maximum === undefined || value <= node.maximum) return value;
  return node.integer === true ? Math.floor(node.maximum) : node.maximum;
}

/**
 * `Object.create(null)`, the shape `@ultimat3/schema`'s own object check already builds: on a `{}`
 * literal `sample['__proto__'] = value` reaches `Object.prototype`'s SETTER, so a required field
 * named `__proto__` never became an own key and REPLACED the sample's prototype instead. The
 * payload then failed the very schema it was derived from, and the contract test reported the
 * action as drifted. A field can carry that name through any computed key
 * (`t.object({ [name]: t.string })`) or a provider whose IR was parsed from JSON.
 *
 * The read is guarded for the same reason `patternAt` guards its own: `requiredKeys` happens to
 * answer own keys only (`Object.entries`), so this is the invariant stated locally rather than
 * borrowed from a function two packages away.
 */
function sampleObject(node: SchemaNode): Record<string, unknown> {
  const properties = node.properties ?? {};
  const sample: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Required-only is what "minimal" means: an optional key and a defaulted one are both
  // absences the schema already accepts, so adding them would only widen what can go wrong.
  for (const key of requiredKeys(node)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
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
 * Best effort, and honest about it: a schema carrying a constraint the IR does not — a provider's
 * own refinement — yields a value the schema rejects. The caller turns that into
 * `X_CONTRACT_DRIFT`, because a silently skipped assertion is the vacuous test this function
 * exists to end. The one constraint the IR DOES carry is `pattern`, and `sampleGaps` reads it.
 */
export function sampleInput(schema: StandardSchemaV1): unknown {
  const node = tryIntrospect(schema);
  return node === undefined ? {} : sampleFor(node);
}

/** The root's name in a gap path — a bare `t.string` input has no field to point at. */
const ROOT_PATH = '(the input)';

/**
 * Dotted paths of every sampled field whose own `pattern` the synthesized value cannot satisfy —
 * "what this schema needs that the framework cannot invent", in the order a reader fills them in.
 *
 * Empty is the common case, including for `t.slug` and `t.cursor`, whose patterns `'sample'`
 * already matches. It walks the SAMPLED shape, so an optional key — which `sampleObject`
 * deliberately omits — owes nothing.
 */
export function sampleGaps(schema: StandardSchemaV1): readonly string[] {
  const node = tryIntrospect(schema);
  return node === undefined ? [] : gapsIn(node, '');
}

function gapsIn(node: SchemaNode, path: string): string[] {
  if (node.nullable === true) return [];
  if (node.kind === 'object') {
    const properties = node.properties ?? {};
    const out: string[] = [];
    for (const key of requiredKeys(node)) {
      const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (child !== undefined) out.push(...gapsIn(child, path === '' ? key : `${path}.${key}`));
    }
    return out;
  }
  if (satisfiesPattern(node, sampleFor(node))) return [];
  return [path === '' ? ROOT_PATH : path];
}

/** `orderRef` -> `orderRef (must match ^ORD-\d{4}$)`, for a cause a reader can act on. */
export function describeSampleGap(schema: StandardSchemaV1, path: string): string {
  const pattern = patternAt(tryIntrospect(schema), path);
  return pattern === undefined ? path : `${path} (must match ${pattern})`;
}

function patternAt(node: SchemaNode | undefined, path: string): string | undefined {
  if (node === undefined) return undefined;
  if (path === '' || path === ROOT_PATH) return node.pattern;
  const [head, ...rest] = path.split('.');
  // `path` is the caller's — `describeSampleGap` is exported — so the same own-property read the
  // format table takes: `properties['constructor']` is otherwise the `Object` function.
  const properties = node.properties ?? {};
  const child =
    head === undefined || !Object.hasOwn(properties, head) ? undefined : properties[head];
  return child === undefined ? undefined : patternAt(child, rest.join('.'));
}
