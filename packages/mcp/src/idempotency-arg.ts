// The MCP half of `idempotent: true`: the Idempotency-Key an HTTP caller sends as a header, sent
// by an MCP caller as one reserved, optional tool ARGUMENT. An argument and not `params._meta`:
// `_meta` is protocol metadata a host fills (a progress token), and no model-driven client lets the
// model set it — the retry that needs a key is the agent's own, so the key goes where the agent
// writes. It is advertised in `tools/list`, enforced by `validate-args.ts` like every other field,
// and taken back out before `invoke`, so the action's own input parse never sees it.

import { MAX_IDEMPOTENCY_KEY_LENGTH } from '@ultimat3/action';
import { McpIdempotencyKeyShadowedError } from './errors';
import type { JsonSchema } from './wire';

/** The reserved argument name on every idempotent action's tool. */
export const MCP_IDEMPOTENCY_KEY_ARG = 'idempotencyKey';

/**
 * Contract text, not UI text — it is what `tools/list` publishes, the same bytes for every caller,
 * like an action's `mcp.description`.
 */
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
 * `schema` with the optional key argument. An input that is not an object has no argument to
 * add, and is left alone; one that already names the argument is refused, never merged.
 */
export function withIdempotencyKeyArg(name: string, schema: JsonSchema): JsonSchema {
  if (schema.type !== 'object') return schema;
  const properties = schema.properties ?? {};
  if (Object.hasOwn(properties, MCP_IDEMPOTENCY_KEY_ARG)) {
    throw new McpIdempotencyKeyShadowedError({ name, argument: MCP_IDEMPOTENCY_KEY_ARG });
  }
  return { ...schema, properties: { ...properties, [MCP_IDEMPOTENCY_KEY_ARG]: KEY_SCHEMA } };
}

/**
 * The call's arguments split into the action's input and the key. Absent, empty-handed or not an
 * object: the input as given and no key — `invoke` then runs the action un-keyed, as HTTP does
 * without the header.
 */
export function takeIdempotencyKeyArg(args: unknown): {
  readonly input: unknown;
  readonly idempotencyKey: string | null;
} {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { input: args, idempotencyKey: null };
  }
  if (!Object.hasOwn(args, MCP_IDEMPOTENCY_KEY_ARG)) return { input: args, idempotencyKey: null };
  const input: Record<string, unknown> = {};
  let key: unknown;
  for (const [field, value] of Object.entries(args)) {
    if (field === MCP_IDEMPOTENCY_KEY_ARG) key = value;
    // defineProperty, never `input[field] =`: a `__proto__` field would re-prototype the copy.
    else
      Object.defineProperty(input, field, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  // `validate-args.ts` already held the value to the advertised string schema, so a non-string can
  // only come from a caller that skipped it — and a value that is not a string is not a key.
  return { input, idempotencyKey: typeof key === 'string' ? key : null };
}
