// Single responsibility: name the keys a value carries that its schema never declared. The parse
// drops them in silence while the published contract says `additionalProperties: false` (#1281);
// this walker is what lets a surface SAY so without changing what the parse answers.

import { isPlainObject } from './builder';
import { MAX_ISSUES } from './issue-cap';
import type { SchemaNode } from './node';
import { formatPath } from './standard';

/** One key the schema does not declare where the value carries it. */
export interface UnknownKey {
  /** The key's full location, `formatPath` spelling: `filter.stauts`, `lines[0].qyt`. */
  readonly path: string;
  /** The caller's key itself — the last segment of `path`. */
  readonly key: string;
  /** The keys the schema DOES declare at that object, in declaration order: `nearestName`'s list. */
  readonly declared: readonly string[];
}

type Segment = string | number;

/**
 * Kinds whose keys are the caller's by design — a record, any JSON, a node the IR cannot describe
 * — plus `money`, whose two keys are the kind itself. A candidate of one of these makes the level
 * open: nothing there is unknown, and nothing below it is walked.
 */
const OPEN_KINDS: ReadonlySet<string> = new Set(['record', 'json', 'unknown', 'money']);

/** Does the arm claim this tag at the discriminant? A literal, or one value of an enum. */
function claims(arm: SchemaNode, discriminant: string, tag: unknown): boolean {
  const at = arm.properties?.[discriminant];
  if (at === undefined || !Object.hasOwn(arm.properties ?? {}, discriminant)) return false;
  if (at.kind === 'literal') return at.literal === tag;
  return at.kind === 'enum' && (at.values ?? []).some((value) => value === tag);
}

/**
 * The nodes that could describe `value`, with unions flattened. A discriminated union contributes
 * only the arm its tag selects — a key borrowed from a sibling arm stays unknown — and a plain one
 * contributes every arm, so a key is unknown only when no arm declares it.
 */
function candidates(nodes: readonly SchemaNode[], value: unknown): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'union') {
      out.push(node);
      continue;
    }
    const arms = node.anyOf ?? [];
    const discriminant = node.discriminant;
    if (discriminant === undefined) {
      out.push(...candidates(arms, value));
      continue;
    }
    if (!isPlainObject(value) || !Object.hasOwn(value, discriminant)) continue;
    const tag = value[discriminant];
    out.push(
      ...candidates(
        arms.filter((arm) => claims(arm, discriminant, tag)),
        value,
      ),
    );
  }
  return out;
}

function walk(nodes: readonly SchemaNode[], value: unknown, path: Segment[], found: UnknownKey[]) {
  const described = candidates(nodes, value);
  if (described.some((node) => OPEN_KINDS.has(node.kind))) return;
  if (Array.isArray(value)) {
    const items = described.flatMap((node) =>
      node.kind === 'array' && node.items !== undefined ? [node.items] : [],
    );
    if (items.length === 0) return;
    for (let index = 0; index < value.length && found.length < MAX_ISSUES; index += 1) {
      walk(items, value[index], [...path, index], found);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  const shapes: Readonly<Record<string, SchemaNode>>[] = [];
  for (const node of described) {
    if (node.kind !== 'object') continue;
    // An object node with no declared properties came from a provider that could not say: open.
    if (node.properties === undefined) return;
    shapes.push(node.properties);
  }
  if (shapes.length === 0) return;
  const declared = [...new Set(shapes.flatMap((shape) => Object.keys(shape)))];
  for (const key of Object.keys(value)) {
    if (found.length >= MAX_ISSUES) return;
    const children = shapes.flatMap((shape) => {
      const child = Object.hasOwn(shape, key) ? shape[key] : undefined;
      return child === undefined ? [] : [child];
    });
    if (children.length === 0) {
      found.push({ path: formatPath([...path, key]), key, declared });
    } else {
      walk(children, value[key], [...path, key], found);
    }
  }
}

/**
 * Every key `value` carries that `node` does not declare: object properties and array items are
 * walked, records and JSON are skipped. Pure and read-only — the parse's answer is untouched — and
 * bounded at `MAX_ISSUES`, the cap every validation stops at, so a hostile body costs a list no
 * longer than its refusal would. Run it on INPUT only: an output or a row is the server's own data.
 */
export function unknownKeys(node: SchemaNode, value: unknown): readonly UnknownKey[] {
  const found: UnknownKey[] = [];
  walk([node], value, [], found);
  return found;
}
