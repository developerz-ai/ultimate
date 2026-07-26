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

/** Render issues as the one-line strings the error contract embeds. */
export function formatIssues(issues: readonly ArgIssue[]): readonly string[] {
  return issues.map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`));
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
    if (properties[key] === undefined) {
      if (schema.additionalProperties === false) {
        issues.push({ path: join(path, key), message: 'unknown property' });
        continue;
      }
      out[key] = source[key];
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    const at = join(path, key);
    const present = Object.hasOwn(source, key) && source[key] !== undefined;
    if (!present) {
      if (child.default !== undefined) out[key] = child.default;
      else if (schema.required?.includes(key) === true) {
        issues.push({ path: at, message: 'is required' });
      }
      continue;
    }
    out[key] = walk(child, source[key], at, issues);
  }
  return out;
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
  return input;
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
