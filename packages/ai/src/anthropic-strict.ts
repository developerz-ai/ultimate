// Which tools of one Anthropic request may carry `strict: true`. On this wire the flag is a promise
// the server checks — a schema outside the documented strict subset, or a request past one of three
// caps, is a 400 — so it is derived per request, never forwarded. Source (read 2026-11-19):
// platform.claude.com/docs/en/build-with-claude/structured-outputs.

import type { JsonSchema, LlmTool } from './tools';

/** "Strict tools per request: 20". A tool sent without the flag does not count. */
export const MAX_STRICT_TOOLS = 20;
/** "Optional parameters: 24" — keys not in `required`, summed over every strict schema. */
export const MAX_STRICT_OPTIONAL = 24;
/** "Parameters with union types: 16" — `anyOf`, summed over every strict schema. */
export const MAX_STRICT_UNIONS = 16;

/**
 * The keywords the strict subset accepts as this package emits them. An ALLOW-list: a keyword the
 * projection grows later is outside it until someone reads the provider's page again. `pattern` is
 * left out on purpose — only "simple" patterns compile, and which those are is not ours to guess.
 */
const ACCEPTED: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'enum',
  'const',
  'default',
  'anyOf',
]);

/** What one schema costs against the request's caps. */
export interface StrictWeight {
  readonly optional: number;
  readonly unions: number;
}

/**
 * `schema`'s weight when it is inside the strict subset, `undefined` when it is not: a length,
 * numeric or array bound (`minItems` 0 and 1 excepted), an object not closed with
 * `additionalProperties: false`, or `anyOf` beside `type` / `properties`.
 */
export function strictSubset(schema: JsonSchema): StrictWeight | undefined {
  for (const key of Object.keys(schema)) if (!ACCEPTED.has(key)) return undefined;
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) {
    return undefined;
  }
  let optional = 0;
  let unions = 0;
  const children: JsonSchema[] = [];
  if (schema.anyOf !== undefined) {
    if (schema.type !== undefined || schema.properties !== undefined) return undefined;
    unions += 1;
    children.push(...schema.anyOf);
  }
  if (schema.items !== undefined) children.push(schema.items);
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (schema.additionalProperties !== false) return undefined;
    const required = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!required.has(key)) optional += 1;
      children.push(child);
    }
  }
  for (const child of children) {
    const weight = strictSubset(child);
    if (weight === undefined) return undefined;
    optional += weight.optional;
    unions += weight.unions;
  }
  return { optional, unions };
}

/**
 * The request's tools as this wire takes them: `strict` kept where the tool asked for it, its
 * schema is inside the subset, and the request stays under all three caps — granted in request
 * order, so the same tools always get the same flags (the tools are a cached prefix). A tool
 * without the flag is sent whole and validated by its own schema on the way back, as every tool
 * call already is.
 */
export function anthropicTools(tools: readonly LlmTool[]): readonly LlmTool[] {
  let strict = 0;
  let optional = 0;
  let unions = 0;
  return tools.map((tool) => {
    const { strict: asked, ...rest } = tool;
    const weight = asked === true ? strictSubset(tool.input_schema) : undefined;
    if (
      weight === undefined ||
      strict + 1 > MAX_STRICT_TOOLS ||
      optional + weight.optional > MAX_STRICT_OPTIONAL ||
      unions + weight.unions > MAX_STRICT_UNIONS
    ) {
      return rest;
    }
    strict += 1;
    optional += weight.optional;
    unions += weight.unions;
    return tool;
  });
}
