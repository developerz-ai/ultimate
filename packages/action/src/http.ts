/**
 * Projections 1 and 2: an action becomes `POST /api/<resource>/<verb>` plus the
 * OpenAPI operation describing it. Policy enforcement, input validation,
 * idempotency and cache invalidation are wired here and are not optional —
 * there is no way to mount an action without them.
 */

import { isMcpExposed, isUltimateError } from '@ultimat3/core';
import type { Bucket, Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { json, problem, redirect, takeRedirect } from '@ultimat3/http';
import type { ActionRateLimit, AnyAction } from './action';
import { ActionRateLimitInvalidError } from './errors';
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
      // The one thing an action's return value cannot say. `setRedirect()` inside the handler
      // is how a `<form method="post">` gets an answer a browser follows — a `Location` on the
      // 200 this used to always return is a header browsers ignore, so a JS-less form left the
      // reader staring at `{"ok":true}`. Only this projection honours it: a redirect is an HTTP
      // fact, and the MCP tool and the job handle share none of it.
      const to = takeRedirect(req.ctx);
      const response = to === undefined ? json(result) : redirect(to.location, to.status);
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
    // Name AND numbers. The name alone selected a bucket the limiter's table never held, so
    // `bucketFor` fell through to `default` — 120 burst for an action that declared 5. The
    // numbers ride along and `withRouteBuckets` registers them at construction.
    ...(def.rateLimit === undefined
      ? {}
      : { rateLimit: name, rateLimitBucket: toBucket(name, def.rateLimit) }),
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
      // The tool name an agent would call, or `null` when there is no tool. `!== false` here
      // advertised one for every action, so an agent reading the spec asked for a tool the MCP
      // catalog never listed — `isMcpExposed` is the same answer `toMcpTool` gives.
      mcpTool: isMcpExposed(def.mcp) ? toToolName(name) : null,
      rateLimit: rateLimitMeta(name, def.rateLimit),
    },
  };
}

/**
 * `{ limit, windowMs }` as the limiter's own vocabulary: `limit` is the burst a caller may spend
 * at once, and the window is what refills it — `5 / 600_000ms` is 5 held, one back every two
 * minutes. The only conversion between the declaration and the enforcement, so the numbers
 * `toOpenApiOperation` publishes and the numbers `withRouteBuckets` registers cannot drift.
 *
 * **The COMPUTED rate is validated, not just the two declared halves.** The division is where a
 * pair that reads fine becomes one the limiter cannot run on, in both directions:
 * `{ limit: Number.MAX_VALUE, windowMs: 1 }` computes to `Infinity` — a bucket that never empties,
 * which is the same "declared a limit, enforced nothing" as `windowMs: 0` — and a tiny limit over
 * a huge window underflows to `0`, a bucket that never refills, so the endpoint is closed after
 * its first burst rather than limited. `capacity` is checked against the cost of one request for
 * the mirror reason: below one token, the first caller is already refused.
 */
export function toBucket(name: string, limit: ActionRateLimit): Bucket {
  const finite = (value: number): boolean => Number.isFinite(value);
  const refuse = (reason: string): never => {
    throw new ActionRateLimitInvalidError(name, limit, reason);
  };
  // A capacity under one token cannot admit a single request, so the endpoint is closed, not
  // limited — a policy's job, never a rate limit's.
  if (!finite(limit.limit) || limit.limit < 1) {
    refuse('limit must be a finite number of at least 1 request');
  }
  if (!finite(limit.windowMs) || limit.windowMs <= 0) {
    refuse('windowMs must be finite and greater than zero');
  }
  const refillPerSecond = limit.limit / (limit.windowMs / 1000);
  // `<= 0` is kept though the two checks above make it unreachable today — with `limit >= 1` and a
  // finite window the smallest rate is `1000 / MAX_VALUE`, ~5.6e-306, which is normal, not zero.
  // It is the guard that has to move first if `limit >= 1` is ever relaxed: an underflow to 0 is a
  // bucket that never refills, i.e. an endpoint closed after its first burst.
  if (!finite(refillPerSecond) || refillPerSecond <= 0) {
    refuse(
      `the refill rate it computes to is ${refillPerSecond} per second, which is a bucket that never empties — nothing would be enforced`,
    );
  }
  return { capacity: limit.limit, refillPerSecond };
}

function rateLimitMeta(
  name: string,
  limit: ActionRateLimit | undefined,
): Record<string, number> | null {
  if (limit === undefined) return null;
  // Validated through the same call the route makes, so the spec cannot publish a pair the
  // limiter would have refused to run on.
  toBucket(name, limit);
  return { limit: limit.limit, windowMs: limit.windowMs };
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
