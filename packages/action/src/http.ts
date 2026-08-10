/**
 * Projections 1 and 2: an action becomes `POST /api/<resource>/<verb>` plus the
 * OpenAPI operation describing it. Policy enforcement, input validation,
 * idempotency and cache invalidation are wired here and are not optional —
 * there is no way to mount an action without them.
 */

import { isUltimateError } from '@ultimat3/core';
import type { Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { json, problem } from '@ultimat3/http';
import type { ActionRateLimit, AnyAction } from './action';
import { actionName, defOf, invoke } from './invoke';
import {
  derivePath,
  inputSchemaName,
  outputSchemaName,
  PROBLEM_SCHEMA_NAME,
  schemaRef,
  toOperationId,
  toToolName,
} from './naming';
import { policyCapability } from './policy-gate';
import { tagKeys } from './tags';

/** Matches `HttpConfig.buildIdHeader`; the pipeline reads it into `ctx.buildId`. */
export const BUILD_ID_HEADER = 'x-ultimate-build';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'x-ultimate-replayed';

/**
 * `publishPost` -> `POST /api/posts/publish`. Derivation: the first camelCase word
 * is the verb, the rest is the resource with its last word pluralized and
 * kebab-cased (`updateUserProfile` -> `/api/user-profiles/update`). See `naming.ts`.
 */
export function toRoute(target: AnyAction): Route {
  const name = actionName(target);
  const { path, resource } = derivePath(name);
  const def = defOf(target);

  const handler = async (req: UltimateRequest): Promise<Response> => {
    try {
      // The pipeline already parsed and size-capped the body; parsing it again here
      // would be a second, differently-behaved parser for the same bytes.
      const raw = await req.bodyRaw();
      const key = def.idempotent === true ? req.header(IDEMPOTENCY_HEADER) : null;
      let replayed = false;
      const result = await invoke(target, raw, {
        surface: 'http',
        idempotencyKey: key,
        onReplay: () => {
          replayed = true;
        },
      });
      const response = json(result);
      if (key !== null) response.headers.set(REPLAYED_HEADER, replayed ? '1' : '0');
      return response;
    } catch (error) {
      // Framework errors carry their own code, status and fix line; anything else is
      // a bug and belongs to the server's error boundary, not to this route.
      if (isUltimateError(error)) return problem(error);
      throw error;
    }
  };

  const meta: RouteMeta = {
    name,
    // `allow(...)` is the only way an action is public, and saying so explicitly is
    // what keeps "forgot the policy" from ever looking like "meant to be public".
    auth: def.policy.kind === 'allow' ? 'public' : 'required',
    policy: policyCapability(def.policy),
    // Named so the pipeline's authz stage stands down: `invoke` is this route's one
    // evaluation, and it is the only one that has run `row` by the time it decides. A
    // stage deciding first would decide from `row: null` — a denial for the row's own
    // author, from an authz system that never saw the row.
    enforcedBy: 'handler',
    input: def.input,
    cache: { mode: 'no-store', tags: tagKeys(def.cache?.invalidates ?? []) },
    tags: [resource],
    ...(def.rateLimit === undefined ? {} : { rateLimit: name }),
    ...(def.mcp?.description === undefined ? {} : { description: def.mcp.description }),
  };

  return { method: 'POST', path, handler, meta };
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly parameters: readonly Record<string, unknown>[];
  readonly requestBody: Record<string, unknown>;
  readonly responses: Record<string, unknown>;
  readonly 'x-ultimate': Record<string, unknown>;
}

/** The operation object for this action. `openapi.ts` assembles them into a document. */
export function toOpenApiOperation(target: AnyAction): OpenApiOperation {
  const name = actionName(target);
  const def = defOf(target);
  const path = derivePath(name);
  const idempotent = def.idempotent === true;
  return {
    operationId: toOperationId(name),
    tags: [path.resource],
    summary: def.mcp?.description ?? name,
    parameters: idempotent ? [IDEMPOTENCY_PARAMETER] : [],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: schemaRef(inputSchemaName(name)) } } },
    },
    responses: {
      '200': {
        description: 'ok',
        content: { 'application/json': { schema: { $ref: schemaRef(outputSchemaName(name)) } } },
      },
      '400': problemResponse('X_INPUT_INVALID'),
      '403': problemResponse('policy denied'),
      ...(idempotent ? { '409': problemResponse('X_IDEMPOTENCY_CONFLICT') } : {}),
    },
    'x-ultimate': {
      capability: policyCapability(def.policy),
      idempotent,
      invalidates: tagKeys(def.cache?.invalidates ?? []),
      mcpTool: def.mcp?.expose === false ? null : toToolName(name),
      rateLimit: rateLimitMeta(def.rateLimit),
    },
  };
}

function rateLimitMeta(limit: ActionRateLimit | undefined): Record<string, number> | null {
  return limit === undefined ? null : { limit: limit.limit, windowMs: limit.windowMs };
}

const IDEMPOTENCY_PARAMETER: Record<string, unknown> = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 255 },
  description: 'Replays the first response for a repeated key.',
};

function problemResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/problem+json': { schema: { $ref: schemaRef(PROBLEM_SCHEMA_NAME) } },
    },
  };
}
