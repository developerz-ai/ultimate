// THE request lifecycle: which stages exist, in what ORDER, why — and the one loop that drives a
// request through them. The order IS the framework's guarantee, an explicit array and not a
// middleware stack, so nothing can skip a stage and `/_x` and `pipeline.test.ts` can both read it.
// The other two thirds of the lifecycle are siblings: `stages.ts` owns what each stage does, and
// `finalize.ts` owns the promise that the tail always answers rather than rejecting.
import { recordRequest, runWithContext, withSpan } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfig } from './config';
import { asCtx, createRequestContext, elapsedMs, type RequestContext } from './context';
import { pipelineNoResponse } from './errors';
import { recoverWith, runFinalize } from './finalize';
import type { ServerHooks } from './hooks';
import type { Middleware } from './middleware';
import { assertRateLimitScope, createRateLimiter, type RateLimiter } from './rate-limit';
import { assertRouteBuckets, withRouteBuckets } from './rate-limit-buckets';
import { UltimateRequest } from './request';
import { problem } from './response';
import type { RouteTable } from './router';
import {
  type Stage,
  type StageDoc,
  type StagePhase,
  stageRunners,
  UNMATCHED_ROUTE,
} from './stages';

export const PIPELINE_STAGES: readonly StageDoc[] = [
  {
    name: 'request-id',
    phase: 'request',
    why: 'first: every log line, span, error body and problem document quotes it, so it must exist before anything can fail',
  },
  {
    name: 'trace',
    phase: 'request',
    why: 'before any I/O: a span started later would silently exclude auth and DB latency from the trace',
  },
  {
    name: 'context',
    phase: 'request',
    why: 'creates the ambient context and binds the matched route; build skew is checked here because a stale client must be told to reload before it gets a 404 for a route it no longer knows',
  },
  {
    name: 'locale',
    phase: 'request',
    why: 'before auth: even a 401 body is localised, and no date/money formatter may run without an explicit locale + IANA tz',
  },
  {
    name: 'auth',
    phase: 'request',
    why: 'before rate limiting so the limiter keys per actor and per tenant instead of punishing a shared NAT address',
  },
  {
    name: 'rate-limit',
    phase: 'request',
    why: 'before the body is read: a limited request must never make the server allocate its payload',
  },
  {
    name: 'body',
    phase: 'request',
    why: 'before authz because policies take the parsed input as their subject (ownsPost(actor, input.postId))',
  },
  {
    name: 'authz',
    phase: 'request',
    why: 'the last gate, and only for a route whose policy nothing downstream evaluates: one policy, decided here exactly as it is in jobs, live queries and MCP tools. A route marked enforcedBy: handler is skipped, because its handler holds the row this stage cannot load',
  },
  { name: 'handler', phase: 'terminal', why: 'the only stage that is app code' },
  {
    name: 'cache-headers',
    phase: 'finalize',
    why: 'after the handler so a handler can override the route default, and before response so a directive cannot drop a security header',
  },
  {
    name: 'error-map',
    phase: 'recover',
    why: 'the single place a throw becomes a status: problem+json for agents and RPC, the dev overlay for browsers',
  },
  {
    name: 'response',
    phase: 'finalize',
    why: 'last: CORS, security headers, server-timing and the accumulated context headers are merged onto whatever the stages produced',
  },
];

export interface PipelineDeps {
  readonly table: RouteTable;
  readonly config?: HttpConfig;
  readonly hooks?: ServerHooks;
  readonly middleware?: readonly Middleware[];
  /**
   * A limiter built elsewhere — `createServer({ rateLimitStore })` is the one supported way, and
   * it hands over a limiter built from the SAME merged config this constructor would have built.
   * One passed from anywhere else resolves bucket names against the table IT closed over, which
   * is why `assertRouteBuckets` compares that table against the routes' declarations and refuses
   * a limiter that cannot enforce one (`X_RATE_LIMIT_BUCKET_UNBOUND`) rather than letting the
   * name fall through to `default`.
   */
  readonly limiter?: RateLimiter;
}

export interface HandleInit {
  readonly role: RequestContext['role'];
  readonly ip?: string | null;
}

export interface Pipeline {
  readonly stages: readonly Stage[];
  readonly config: HttpConfig;
  /**
   * Runs the full lifecycle for one request and always resolves to a Response — a stage that
   * throws after the handler, or while rendering another stage's throw, degrades to the coded
   * 500 (`X_PIPELINE_FINALIZE_FAILED`) rather than rejecting. A caller has a socket open.
   */
  handle(request: Request, init: HandleInit): Promise<Response>;
}

export const createPipeline = (deps: PipelineDeps): Pipeline => {
  // Routes first, config second, and the merge here: `defineHttpConfig` cannot see a route, so a
  // bucket a route declares only becomes real at the construction that holds both. Idempotent, so
  // a config `createServer` already merged passes through unchanged.
  const config = withRouteBuckets(deps.config ?? defineHttpConfig(), deps.table.routes);
  const limiter = deps.limiter ?? createRateLimiter({ config: config.rateLimit });
  // Here rather than in `createServer`: this is the one construction path every server, test and
  // embedder shares, so a limiter that cannot keep the app's declaration is refused exactly once.
  // Two halves of one question — where the counters live, and which buckets the limiter holds.
  assertRateLimitScope(config.rateLimit, limiter);
  assertRouteBuckets(limiter, deps.table.routes);
  const run = stageRunners({
    table: deps.table,
    config,
    limiter,
    hooks: deps.hooks ?? {},
    middleware: deps.middleware ?? [],
  });
  const stages: readonly Stage[] = PIPELINE_STAGES.map((doc) => ({ ...doc, run: run[doc.name] }));

  const byPhase = (phase: StagePhase): readonly Stage[] =>
    stages.filter((stage) => stage.phase === phase);
  const requestStages = byPhase('request');
  const finalizeStages = byPhase('finalize');
  const terminal = stages.find((stage) => stage.phase === 'terminal');
  const recovered = recoverWith(stages.find((stage) => stage.phase === 'recover'));

  const execute = async (request: UltimateRequest, ctx: RequestContext): Promise<Response> => {
    try {
      for (const stage of requestStages) {
        const short = await stage.run(request, ctx);
        if (short !== undefined) {
          ctx.response = short;
          break;
        }
      }
      if (ctx.response === undefined && terminal !== undefined) {
        ctx.response = (await terminal.run(request, ctx)) ?? new Response(null, { status: 204 });
      }
    } catch (error) {
      ctx.error = error;
      ctx.response = await recovered(request, ctx);
    }
    // `finalize.ts`, not a loop here: these two stages run after the request is already answered
    // or already failed, so a throw of their own has nothing left to catch it — and `handle`
    // promises a Response.
    await runFinalize(finalizeStages, request, ctx, recovered);
    return ctx.response ?? problem(pipelineNoResponse('response'));
  };

  return {
    stages,
    config,
    async handle(raw, init) {
      const url = new URL(raw.url);
      const ctx = createRequestContext({
        url,
        method: raw.method,
        role: init.role,
        config,
        ip: init.ip ?? null,
        // The context is what app code reaches through core's ALS; without the inbound headers
        // on it, a cookie the server itself set could never be read back on the next request,
        // and `ctx.session` had no way to exist.
        requestHeaders: raw.headers,
      });
      const request = new UltimateRequest(raw, ctx);
      // The ALS scope is entered here, before stage 1, so every stage — and everything
      // a handler calls — sees the same context object without threading it by hand.
      return await runWithContext(asCtx(ctx), () =>
        withSpan(
          `${ctx.method} ${url.pathname}`,
          async (span) => {
            // This package's ONE metrics call site. `finally`, not the happy line: `execute`
            // answers every stage's throw with a problem response, but a counter that skipped the
            // requests the server handled worst is the one an autoscaler must not have — so a
            // rejection nothing here predicted still counts, at the 500 such a request gets from
            // the caller either way.
            let status = 500;
            try {
              const response = await execute(request, ctx);
              status = response.status;
              // The root span of every request carried no attributes at all, so an exporter got a
              // name and a duration and nothing to correlate: which request, which outcome. These
              // four are what a reader joins on — `x-request-id` off the response, the status the
              // client saw, and the method/path split out of the span name.
              span.setAttributes({
                'http.request_id': ctx.requestId,
                'http.method': ctx.method,
                'http.route': url.pathname,
                'http.status_code': response.status,
              });
              return response;
            } finally {
              // The span may carry the concrete path — a trace is sampled and thrown away. A
              // metric is a stored series per label set, so this is the route PATTERN
              // (`/posts/:id`), and `recordRequest` folds the status to its class for the same
              // reason. Nothing here is attacker-chosen or per-user.
              recordRequest({
                method: ctx.method,
                route: ctx.route?.path ?? UNMATCHED_ROUTE,
                status,
                durationMs: elapsedMs(ctx),
              });
            }
          },
          { kind: 'server' },
        ),
      );
    },
  };
};
