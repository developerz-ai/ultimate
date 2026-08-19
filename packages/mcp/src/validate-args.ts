// Argument validation against a tool's declared JSON Schema — the ONE arg contract.
//
// Why not a second validator alongside the schema: `tools/list` hands the agent a JSON
// Schema, so that document must be the thing enforced. If a tool could also carry a
// private validator the agent would be judged against a contract it never saw. Actions
// still re-parse authoritatively inside their own handler; this pass exists so a wrong
// call comes back as a structured issue list instead of a round trip.

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
  if (schema.minLength !== undefined && input.length < schema.minLength) {
    issues.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (schema.maxLength !== undefined && input.length > schema.maxLength) {
    issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (schema.pattern !== undefined) matchesPattern(schema.pattern, input, path, issues);
  return input;
}

/**
 * A pattern this server cannot COMPILE is refused, not skipped. `tools/list` published it, so an
 * agent has already been told the rule — passing a call the server cannot check is the silent-pass
 * this whole module exists to prevent. Every framework-projected pattern is a `RegExp.source` and
 * compiles; only a hand-written tool can reach the second branch, and that is its author's bug.
 */
function matchesPattern(pattern: string, input: string, path: string, issues: ArgIssue[]): void {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
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
