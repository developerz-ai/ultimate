// The in-app half of `idempotent: true`: an agent's tool carries the reserved `idempotencyKey`
// argument exactly as `@ultimat3/mcp`'s does, so an action an external agent may retry safely is
// one an in-app agent may retry safely too. Restated, not imported — `mcp` is this package's own
// tier — and held equal to `mcp/src/idempotency-arg.ts` by `scripts/ai-mcp-tool-parity.test.ts`.

import { MAX_IDEMPOTENCY_KEY_LENGTH } from '@ultimat3/action';
import { UltimateError } from '@ultimat3/core';
import type { JsonSchema } from './tools';

/** The reserved argument name on every idempotent action's tool — the one MCP reserves. */
export const TOOL_IDEMPOTENCY_KEY_ARG = 'idempotencyKey';

/** Contract text, byte-identical to MCP's: it is what the model reads on either surface. */
const DESCRIPTION =
  'Idempotency key. Retrying this call with the same key and the same arguments returns the ' +
  'first result instead of running it again; the same key with different arguments is refused. ' +
  'Any unique string, e.g. a UUID — reuse it only to retry.';

const KEY_SCHEMA: JsonSchema = {
  type: 'string',
  description: DESCRIPTION,
  minLength: 1,
  maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
};

/**
 * MCP's own refusal, raised for the same tool: an agent tool is an MCP-exposed action by
 * construction (`X_AGENT_TOOL_UNEXPOSED`), so this is the projection `@ultimat3/mcp` refuses too,
 * and one code for it on both surfaces is the parity. Never titled here — `mcp` registers it.
 */
export class ToolIdempotencyKeyShadowedError extends UltimateError {
  constructor(input: { readonly name: string; readonly argument: string }) {
    super({
      code: 'X_MCP_IDEMPOTENCY_KEY_SHADOWED',
      cause: `${input.name} is idempotent and its input declares "${input.argument}", the MCP argument reserved for the idempotency key`,
      fix: `rename ${input.name}'s "${input.argument}" input field — MCP clients send the Idempotency-Key as the reserved "${input.argument}" argument, and the action receives the rest`,
      meta: { action: input.name, argument: input.argument },
    });
  }
}

/** `schema` with the optional key argument; a non-object input is left alone, a clash refused. */
export function withToolIdempotencyKey(name: string, schema: JsonSchema): JsonSchema {
  if (schema.type !== 'object') return schema;
  const properties = schema.properties ?? {};
  if (Object.hasOwn(properties, TOOL_IDEMPOTENCY_KEY_ARG)) {
    throw new ToolIdempotencyKeyShadowedError({ name, argument: TOOL_IDEMPOTENCY_KEY_ARG });
  }
  return { ...schema, properties: { ...properties, [TOOL_IDEMPOTENCY_KEY_ARG]: KEY_SCHEMA } };
}

/**
 * The model's arguments split into the action's input and the key. No key is an un-keyed run, as
 * HTTP without the header; a non-string is no key. A blank or over-long one goes to `invoke`, whose
 * `X_IDEMPOTENCY_KEY_INVALID` the model reads as a tool error naming the bound.
 */
export function takeToolIdempotencyKey(args: unknown): {
  readonly input: unknown;
  readonly idempotencyKey: string | null;
} {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { input: args, idempotencyKey: null };
  }
  if (!Object.hasOwn(args, TOOL_IDEMPOTENCY_KEY_ARG)) return { input: args, idempotencyKey: null };
  const input: Record<string, unknown> = {};
  let key: unknown;
  for (const [field, value] of Object.entries(args)) {
    if (field === TOOL_IDEMPOTENCY_KEY_ARG) key = value;
    // defineProperty, never `input[field] =`: a `__proto__` field would re-prototype the copy.
    else
      Object.defineProperty(input, field, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return { input, idempotencyKey: typeof key === 'string' ? key : null };
}
