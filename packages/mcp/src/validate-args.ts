// Argument validation against a tool's declared JSON Schema — the ONE arg contract.
//
// Why not a second validator alongside the schema: `tools/list` hands the agent a JSON
// Schema, so that document must be the thing enforced. If a tool could also carry a
// private validator the agent would be judged against a contract it never saw. Actions
// still re-parse authoritatively inside their own handler; this pass exists so a wrong
// call comes back as a structured issue list instead of a round trip.

import { charCount } from '@ultimat3/schema';
import type { JsonSchema } from './wire';

export interface ArgIssue {
  /** Dotted path from the arguments root, `''` for the root itself. */
  readonly path: string;
  readonly message: string;
}

export type ArgValidation =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly ArgIssue[] };

/**
 * Validate `raw` against `schema`, applying declared `default`s. Returns the coerced
 * record so a handler reads defaults without repeating them.
 */
export function validateArgs(schema: JsonSchema, raw: unknown): ArgValidation {
  const issues: ArgIssue[] = [];
  const value = walk(schema, raw ?? {}, '', issues);
  if (issues.length > 0) return { ok: false, issues };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '', message: 'arguments must be an object' }] };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function walk(schema: JsonSchema, input: unknown, path: string, issues: ArgIssue[]): unknown {
  if (schema.anyOf !== undefined) return anyOf(schema.anyOf, input, path, issues);
  if (schema.const !== undefined && input !== schema.const) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return input;
  }
  if (schema.enum !== undefined && !schema.enum.includes(input as string)) {
    issues.push({ path, message: `must be one of ${schema.enum.map(String).join(' | ')}` });
    return input;
  }
  switch (schema.type) {
    case 'object':
      return object(schema, input, path, issues);
    case 'array':
      return array(schema, input, path, issues);
    case 'string':
      return string(schema, input, path, issues);
    case 'number':
    case 'integer':
      return number(schema, input, path, issues);
    case 'boolean':
      if (typeof input !== 'boolean') issues.push({ path, message: 'must be a boolean' });
      return input;
    case 'null':
      if (input !== null) issues.push({ path, message: 'must be null' });
      return input;
    default:
      return input;
  }
}

function object(
  schema: JsonSchema,
  input: unknown,
  path: string,
  issues: ArgIssue[],
): Record<string, unknown> | unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push({ path, message: 'must be an object' });
    return input;
  }
  const source = input as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    // `Object.hasOwn`, never `properties[key] === undefined`: the second walks the prototype
    // chain, so `constructor`, `toString` and `__proto__` read as DECLARED on every schema and an
    // argument named after one was accepted past an `additionalProperties: false` that forbids it,
    // then silently dropped. Same discriminator as the loop below, which always had it right.
    if (!Object.hasOwn(properties, key)) {
      if (schema.additionalProperties === false) {
        issues.push({ path: join(path, key), message: 'unknown property' });
        continue;
      }
      put(out, key, source[key]);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    const at = join(path, key);
    const present = Object.hasOwn(source, key) && source[key] !== undefined;
    if (!present) {
      if (child.default !== undefined) put(out, key, child.default);
      else if (schema.required?.includes(key) === true) {
        issues.push({ path: at, message: 'is required' });
      }
      continue;
    }
    put(out, key, walk(child, source[key], at, issues));
  }
  return out;
}

/**
 * One validated key onto the result. `out[key] = value` is not an assignment for exactly one
 * name: `__proto__` runs `Object.prototype`'s setter and REPLACES the object's prototype instead
 * of adding a key, so a caller-chosen argument name decides what the handler's `args.isAdmin`
 * reads. `defineProperty` writes a plain own data property whatever the name is.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

function array(schema: JsonSchema, input: unknown, path: string, issues: ArgIssue[]): unknown {
  if (!Array.isArray(input)) {
    issues.push({ path, message: 'must be an array' });
    return input;
  }
  const items = schema.items;
  if (items === undefined) return input;
  return input.map((item, index) => walk(items, item, `${path}[${index}]`, issues));
}

function string(schema: JsonSchema, input: unknown, path: string, issues: ArgIssue[]): unknown {
  if (typeof input !== 'string') {
    issues.push({ path, message: 'must be a string' });
    return input;
  }
  // `charCount`, never `input.length`: JSON Schema defines these two over CODE POINTS, which is
  // the unit `@ultimat3/schema`'s `char-count.ts` mints them in and the unit the action's own
  // re-parse applies. In code units both directions were wrong on any astral value — `'👍a'` is
  // 3 units and 2 points, so `min(3)` passed here and then answered `X_INPUT_INVALID` inside the
  // handler (the silent pass this file exists to prevent), and `'👍👍'` is 4 units and 2 points,
  // so `max(3)` refused a call the tool would have served, quoting a bound the agent obeyed with
  // no re-parse behind it to disagree. One import rather than a second count: this package is
  // tier 4 and `@ultimat3/schema` is tier 0, so the excuse core's private twin has is not ours.
  const length = charCount(input);
  if (schema.minLength !== undefined && length < schema.minLength) {
    issues.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (schema.pattern !== undefined) matchesPattern(schema, schema.pattern, input, path, issues);
  return input;
}

/**
 * Compiled ONCE per schema NODE, never once per call. A tool's schema is registered at boot and
 * every `tools/call` validates against that same object, so `new RegExp(pattern)` in the hot path
 * was per-request work over a constant — `@ultimat3/schema`'s `patternTester` already draws the
 * line in the same place for the same contract.
 *
 * Keyed on the NODE rather than on the pattern STRING, and a `WeakMap` rather than a `Map`: a
 * pattern reaches this file from a tool an app registered, and a process that registers tools
 * dynamically would otherwise accumulate one entry per distinct pattern string forever, with no
 * bound and nothing to evict it. Keyed on the node, the entry dies with the schema.
 *
 * `null` is a CACHED verdict, not a miss — an uncompilable pattern would otherwise re-enter the
 * `try` on every call, which is the case with the highest per-call cost.
 */
const compiledPatterns = new WeakMap<JsonSchema, RegExp | null>();

/** Test-only probe. A count that climbs once per CALL rather than once per schema is the memo gone. */
let compilations = 0;
export const compiledPatternCount = (): number => compilations;

/**
 * A pattern this server cannot COMPILE is refused, not skipped. `tools/list` published it, so an
 * agent has already been told the rule — passing a call the server cannot check is the silent-pass
 * this whole module exists to prevent. Every framework-projected pattern is a `RegExp.source` and
 * compiles; only a hand-written tool can reach the second branch, and that is its author's bug.
 */
function matchesPattern(
  schema: JsonSchema,
  pattern: string,
  input: string,
  path: string,
  issues: ArgIssue[],
): void {
  let compiled = compiledPatterns.get(schema);
  if (compiled === undefined) {
    compilations += 1;
    try {
      compiled = new RegExp(pattern);
    } catch {
      compiled = null;
    }
    compiledPatterns.set(schema, compiled);
  }
  if (compiled === null) {
    issues.push({ path, message: `declares a pattern this server cannot compile: ${pattern}` });
    return;
  }
  if (!compiled.test(input)) issues.push({ path, message: `must match ${pattern}` });
}

function number(schema: JsonSchema, input: unknown, path: string, issues: ArgIssue[]): unknown {
  if (typeof input !== 'number' || Number.isNaN(input)) {
    issues.push({ path, message: 'must be a number' });
    return input;
  }
  if (schema.type === 'integer' && !Number.isInteger(input)) {
    issues.push({ path, message: 'must be an integer' });
  }
  if (schema.minimum !== undefined && input < schema.minimum) {
    issues.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && input > schema.maximum) {
    issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  return input;
}

/** First branch that validates wins; if none does, report the union, not each branch. */
function anyOf(
  branches: readonly JsonSchema[],
  input: unknown,
  path: string,
  issues: ArgIssue[],
): unknown {
  for (const branch of branches) {
    const local: ArgIssue[] = [];
    const value = walk(branch, input, path, local);
    if (local.length === 0) return value;
  }
  issues.push({ path, message: `does not match any of the ${branches.length} allowed shapes` });
  return input;
}

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);
