// Single responsibility: does a value have the SHAPE a node names, one level deep — the question
// `coerce.ts` asks to pick the union member a raw HTTP value was written for.

import { isPlainObject } from './builder';
import { isJsonShape } from './json-value';
import type { SchemaNode } from './node';

/**
 * Whether `value` is the SHAPE `node` names — one level deep, which is all a union needs to pick
 * a branch. Not validation: it never reads a bound, a pattern or a refinement, so a value that
 * fits can still be refused, with the real message, by the schema it is handed to next.
 *
 * An object fits when every LITERAL field it declares holds that literal — the tag of a
 * discriminated union, read off the IR without asking which key the discriminant is.
 */
export function fits(node: SchemaNode, value: unknown): boolean {
  switch (node.kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return value instanceof Date;
    case 'literal':
      return value === node.literal;
    case 'enum':
      return (node.values ?? []).some((member) => member === value);
    case 'array':
      return Array.isArray(value);
    case 'record':
    case 'money':
      return isPlainObject(value);
    case 'object': {
      if (!isPlainObject(value)) return false;
      return Object.entries(node.properties ?? {}).every(
        ([key, child]) =>
          child.kind !== 'literal' ||
          (child.optional === true && !Object.hasOwn(value, key)) ||
          (Object.hasOwn(value, key) && value[key] === child.literal),
      );
    }
    case 'union':
      return (node.anyOf ?? []).some((member) => fits(member, value));
    case 'json':
      return isJsonShape(value);
    default:
      return false;
  }
}
