/**
 * `@ultimat3/schema/sample`, off the barrel: a value an input schema accepts, derived from that
 * schema's own IR. One walker, parameterised by a `Draw` — `minimalDraw` is the policy assertion's
 * single sample, `seededDraw` the contract step's generated inputs. Never in `t`'s bundle graph.
 */

import type { SchemaNode } from './node';
import { requiredKeys } from './node';
import { tryIntrospect } from './provider';
import type { Draw } from './sample-draw';
import {
  BY_FORMAT,
  formatValue,
  minimalDraw,
  owedItems,
  SAMPLE_STRING,
  satisfiesPattern,
} from './sample-draw';
import { seededDraw } from './sample-seeded';
import type { StandardSchemaV1 } from './standard';

export type { Draw } from './sample-draw';
export { minimalDraw, SAMPLE_ITEMS_MAX } from './sample-draw';
export { BOUNDARY_RUNS, seededDraw } from './sample-seeded';

/**
 * `Object.create(null)`, the shape the object parser already builds: on a `{}` literal
 * `sample['__proto__'] = value` reaches `Object.prototype`'s SETTER, so a required field named
 * `__proto__` replaced the sample's prototype and the payload failed the schema it came from.
 * Required keys always; an optional or defaulted one only when the draw includes it.
 */
function sampleObject(node: SchemaNode, draw: Draw): Record<string, unknown> {
  const properties = node.properties ?? {};
  const required = new Set(requiredKeys(node));
  const sample: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(properties)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (child === undefined) continue;
    if (required.has(key) || draw.include(key)) sample[key] = sampleFor(child, draw);
  }
  return sample;
}

function sampleString(node: SchemaNode, draw: Draw): string {
  // A format value is already the exact shape its validator wants; padding or drawing it would
  // break the only thing that makes it valid.
  return formatValue(node) ?? draw.string(node);
}

/** The walk itself. Every choice the node leaves open is the draw's. */
function sampleFor(node: SchemaNode, draw: Draw): unknown {
  if (node.nullable === true && draw.nullable(node)) return null;
  switch (node.kind) {
    case 'string':
      return sampleString(node, draw);
    case 'number':
      return draw.number(node);
    case 'boolean':
      return draw.boolean();
    case 'date':
      return BY_FORMAT['date-time'];
    case 'enum':
      return draw.member(node.values ?? []) ?? SAMPLE_STRING;
    case 'literal':
      return node.literal ?? null;
    // Items are walked one by one, so a seeded draw varies them; the minimal one repeats.
    case 'array':
      return Array.from({ length: draw.items(node) }, () =>
        node.items === undefined ? null : sampleFor(node.items, draw),
      );
    case 'union': {
      const member = draw.member(node.anyOf ?? []);
      return member === undefined ? null : sampleFor(member, draw);
    }
    case 'record':
      return {};
    case 'money':
      return {
        minor: draw.number({ kind: 'number', integer: true, minimum: 0, maximum: 1_000_000 }),
        currency: 'USD',
      };
    case 'object':
      return sampleObject(node, draw);
    default:
      // `unknown`, `json`, and any kind a third-party provider emits that this build has never
      // heard of. Not `assertNever`: a swapped provider must not turn a contract test into a crash.
      return null;
  }
}

/**
 * The minimal value `schema` accepts — best effort, and honest about it: a provider refinement the
 * IR does not carry yields a value the schema rejects, which the caller reports as
 * `X_CONTRACT_DRIFT`. The one constraint the IR DOES carry is `pattern`, and `sampleGaps` reads it.
 */
export function sampleInput(schema: StandardSchemaV1): unknown {
  const node = tryIntrospect(schema);
  return node === undefined ? {} : sampleFor(node, minimalDraw);
}

/** Where in the replayable sequence a value comes from: the caller's seed and the run index. */
export interface ArbitraryOptions {
  readonly seed: number;
  readonly run: number;
}

/** A generated value under `schema`'s IR: the same `{ seed, run }`, the same value, every time. */
export function arbitrary(schema: StandardSchemaV1, options: ArbitraryOptions): unknown {
  const node = tryIntrospect(schema);
  return node === undefined ? {} : sampleFor(node, seededDraw(options.seed, options.run));
}

/** The root's name in a gap path — a bare `t.string` input has no field to point at. */
const ROOT_PATH = '(the input)';

/**
 * Dotted paths of every sampled field whose own `pattern` the minimal value cannot satisfy — what
 * this schema needs that the framework cannot invent. It walks the SAMPLED shape, so an optional
 * key, which the minimal sample omits, owes nothing.
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
  const unbuildable = node.kind === 'array' && owedItems(node) === undefined;
  if (!unbuildable && satisfiesPattern(node, sampleFor(node, minimalDraw))) return [];
  return [path === '' ? ROOT_PATH : path];
}

/** `orderRef` -> `orderRef (must match ^ORD-\d{4}$)`, for a cause a reader can act on. */
export function describeSampleGap(schema: StandardSchemaV1, path: string): string {
  const node = nodeAt(tryIntrospect(schema), path);
  if (node?.kind === 'array' && node.minItems !== undefined && owedItems(node) === undefined) {
    return `${path} (needs at least ${node.minItems} items)`;
  }
  const pattern = node?.pattern;
  return pattern === undefined ? path : `${path} (must match ${pattern})`;
}

function nodeAt(node: SchemaNode | undefined, path: string): SchemaNode | undefined {
  if (node === undefined) return undefined;
  if (path === '' || path === ROOT_PATH) return node;
  const [head, ...rest] = path.split('.');
  // `path` is the caller's, so the own-property read the format table takes.
  const properties = node.properties ?? {};
  const child =
    head === undefined || !Object.hasOwn(properties, head) ? undefined : properties[head];
  return child === undefined ? undefined : nodeAt(child, rest.join('.'));
}
