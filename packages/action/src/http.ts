/**
 * Projections 1 and 2: an action becomes `POST /api/<resource>/<verb>` plus the
 * OpenAPI operation describing it. Policy enforcement, input validation,
 * idempotency and cache invalidation are wired here and are not optional —
 * there is no way to mount an action without them.
 */

import { tagKeys } from '@ultimat3/cache';
import { isMcpExposed, isUltimateError } from '@ultimat3/core';
import type { Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
// `toBucket` is `@ultimat3/http`'s, not this package's: http owns `Bucket` and the limiter maths,
// and `@ultimat3/query` needs the identical conversion while being the same tier as this one — so
// a copy here would be a second answer to "what does this limit mean" for the read half.
import { json, problem, redirect, takeRedirect, toBucket } from '@ultimat3/http';
import type { ActionRateLimit, AnyAction } from './action';
import type { Deprecation } from './deprecation';
import { applyHeaders, recordDeprecatedCall, renderDeprecation } from './deprecation';
import { ActionDeprecationInvalidError } from './errors';
import { actionName, defOf, invoke } from './invoke';
import {
  derivePath,
  inputSchemaName,
  outputSchemaName,
  PROBLEM_SCHEMA_NAME,
  schemaRef,
  toOperationId,
} from './naming';
import { policyCapability } from './policy-gate';

/** Matches `HttpConfig.buildIdHeader`; the pipeline reads it into `ctx.clientBuildId` — the
 * CLIENT's claim, never `ctx.buildId`, which is the build this process serves. */
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
  // Rendered ONCE, at projection: a date that cannot become a header is a mount-time refusal,
  // not a surprise on the first request — the same rule `toBucket` follows for a rate limit.
  const sunsetting = deprecationHeadersFor(name, def.deprecated);

  const handler = async (req: UltimateRequest): Promise<Response> => {
    if (sunsetting !== undefined) recordDeprecatedCall('action', name);
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
      // On the failure path too, below: a client polling a deprecated endpoint that is currently
      // 403ing still has to learn the endpoint is going away. Announcing it only on 200 hides the
      // sunset from exactly the callers most likely to be stale.
      if (sunsetting !== undefined) applyHeaders(response, sunsetting);
      return response;
    } catch (error) {
      // Framework errors carry their own code, status and fix line; anything else is
      // a bug and belongs to the server's error boundary, not to this route.
      if (!isUltimateError(error)) throw error;
      const response = problem(error);
      if (sunsetting !== undefined) applyHeaders(response, sunsetting);
      return response;
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
    // `input` stays ABSENT, deliberately, exactly as `@ultimat3/query`'s `toQueryRoute` leaves it.
    // Setting it hands the action's schema to the pipeline's `body` stage, which throws
    // `bodyInvalid` — so this route answered `422 X_BODY_INVALID` for every malformed body while
    // the operation two hundred lines down published `400 X_INPUT_INVALID`, and the SAME action
    // called over MCP, over the typed client or directly answered `X_INPUT_INVALID`. One action,
    // one input schema, two codes, decided by the surface the call arrived through.
    //
    // `invoke`'s own `validateInput` is the one parser now, and nothing is lost by dropping this:
    // `bodyRaw()` still parses by content-type, caches, and enforces the size cap — the body stage
    // only ever added SCHEMA validation on top. `X_BODY_INVALID` keeps its job, which is a body
    // failing a plain `route.ts`'s own schema, where no primitive owns the input.
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
  /** OpenAPI's own flag. Absent — not `false` — when nothing is deprecated, so the spec bytes
   * of an app that deprecates nothing are unchanged and `x verify`'s contract diff stays quiet. */
  readonly deprecated?: boolean;
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
  const deprecation = deprecationMetaFor(name, def.deprecated);
  return {
    operationId: toOperationId(name),
    tags: [path.resource],
    summary: def.mcp?.description ?? name,
    ...(deprecation === undefined ? {} : { deprecated: true }),
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
      // BOTH, because they are two different failures and this operation published only one of
      // them while the route answered only the other. `X_INPUT_INVALID` is the body that parsed
      // and failed THIS action's declared schema — the primitive's own code, identical over MCP,
      // the typed client and a direct call. `X_BODY_INVALID` is the bytes never becoming a body
      // at all: malformed JSON, over `bodyLimitBytes`, an unreadable content type. That one is
      // HTTP-only, because only HTTP has bytes, and it is raised in `bodyRaw()` before any schema
      // exists to fail.
      '400': problemResponse('X_INPUT_INVALID'),
      '422': problemResponse('X_BODY_INVALID'),
      '403': problemResponse('policy denied'),
      ...(idempotent ? { '409': problemResponse('X_IDEMPOTENCY_CONFLICT') } : {}),
    },
    'x-ultimate': {
      capability: policyCapability(def.policy),
      idempotent,
      invalidates: tagKeys(def.cache?.invalidates ?? []),
      // The tool name an agent would call, or `null` when there is no tool. `!== false` here
      // advertised one for every action, so an agent reading the spec asked for a tool the MCP
      // catalog never listed — `isMcpExposed` is the same answer `toMcpTool` gives. The NAME was
      // the second half of the same defect: `toToolName` published `publish_post` while
      // `@ultimat3/mcp` served `publishPost`, so a spec-reading agent called a tool that does not
      // exist. Verbatim, and never derived — this is a published contract, not a label.
      mcpTool: isMcpExposed(def.mcp) ? name : null,
      rateLimit: rateLimitMeta(name, def.rateLimit),
      // The dates as data, beside the boolean flag OpenAPI defines: `deprecated: true` says an
      // operation is going away and nothing else, so a client that wants to plan the migration
      // has to read the sunset out of prose. Absent, not null, for the same byte-stability
      // reason `deprecated` is.
      ...(deprecation === undefined ? {} : { deprecation }),
    },
  };
}

/**
 * The headers this action's `deprecated:` block renders to, or nothing. The successor's URL comes
 * from `derivePath` — the same derivation the route and the client use, never a second one.
 */
function deprecationHeadersFor(
  name: string,
  deprecated: Deprecation | undefined,
): Readonly<Record<string, string>> | undefined {
  if (deprecated === undefined) return undefined;
  const successor =
    deprecated.replacedBy === undefined ? undefined : derivePath(deprecated.replacedBy).path;
  const rendered = renderDeprecation(deprecated, successor);
  if (!rendered.ok) throw new ActionDeprecationInvalidError(name, rendered.field, rendered.value);
  return rendered.headers;
}

/** The same declaration as spec data. Validated through the same render, so the two agree. */
function deprecationMetaFor(
  name: string,
  deprecated: Deprecation | undefined,
): Readonly<Record<string, string>> | undefined {
  if (deprecated === undefined) return undefined;
  const rendered = renderDeprecation(deprecated, undefined);
  if (!rendered.ok) throw new ActionDeprecationInvalidError(name, rendered.field, rendered.value);
  return rendered.meta;
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
