/**
 * Projection: a query becomes `GET /_x/query/<kebab>` — the URL `client.ts` already
 * derives and fetches. The search string is the input, decoded at the wire and judged
 * by `runQuery`, so the endpoint cannot drift from the MCP tool, the live window or a
 * direct server call, and cannot acquire a second authz path while doing it.
 */

import { tagKeys } from '@ultimat3/cache';
import { isUltimateError } from '@ultimat3/core';
import type { Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { json, problem, toBucket } from '@ultimat3/http';
import { coerceQuery } from '@ultimat3/schema';
import type { Deprecation } from './deprecation';
import { applyHeaders, recordDeprecatedCall, renderDeprecation } from './deprecation';
import { QueryDeprecationInvalidError } from './errors';
import { derivePath } from './naming';
import { admitsAnonymous, policyCapability } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName, runQuery } from './read';

/**
 * `liveFeed` -> `GET /_x/query/live-feed`. Named for the primitive rather than spelled
 * `toRoute`, because a host mounts this beside `@ultimat3/action`'s and an alias at the
 * import site is a name the reader has to hold — the same reason the tool projection
 * here is `toQueryTool`.
 */
export function toQueryRoute(target: AnyQuery): Route {
  const name = queryName(target);
  // Rendered ONCE, at projection: a date that cannot become a header is a mount-time refusal,
  // not a surprise on the first read.
  const sunsetting = deprecationHeadersFor(name, target.deprecated);

  const handler = async (request: UltimateRequest): Promise<Response> => {
    if (sunsetting !== undefined) recordDeprecatedCall('query', name);
    try {
      // Coerced, then validated — two different jobs, and only the first one belongs to a
      // wire. A search string is characters, so `t.number` and `t.boolean` need the HTTP
      // boundary's decode (`coerceQuery` never invents data: what it cannot convert it
      // hands on untouched). VALIDATING here — `request.query(schema)` — would be the
      // second parser: the same read would answer `X_BODY_INVALID` where every other
      // surface answers `X_INPUT_INVALID` with the line that prints its schema. `runQuery`
      // is the one that decides, exactly as it does for a direct server call.
      const input = coerceQuery(target.input, request.queryRaw());
      const response = json(await runQuery(target, input, { surface: 'http' }));
      // On the failure path too, below: a client polling a deprecated read that is currently
      // 403ing still has to learn the read is going away.
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
    // Derived from a WALK of the policy tree, never from the root combinator alone.
    // `policy.kind === 'allow'` answered `required` for `or(allow(), can('x:y'))`, so the pipeline
    // 401'd an anonymous caller the policy itself allows — while the MCP tool and a direct server
    // read let the same caller through the same object. `public` here is not "unguarded":
    // `enforcedBy: 'handler'` below means `runQuery` still evaluates the policy for every read.
    auth: admitsAnonymous(target.policy) ? 'public' : 'required',
    policy: policyCapability(target.policy),
    // `runQuery` is this route's one evaluation and it decides from the PARSED input the
    // rule reads (`ownsOrg(actor, input.orgId)`); the stage would decide the same policy
    // from raw strings, and would need an `authorize` hook wired to decide at all.
    enforcedBy: 'handler',
    // `input` stays absent, deliberately: the pipeline's body stage validates `meta.input`
    // against the BODY, and a GET has none — declaring it would fail every read on an
    // absent body before the handler ran. The schema is not skipped, it is applied in the
    // handler, by the same `runQuery` every other surface goes through.

    // A read is answered per actor — the policy decided for this caller, and `sql` may
    // scope the rows to them — while the URL names no actor at all. `public` would hand
    // one actor's rows to the next caller of that URL, so a read is `no-store` and a
    // shared cache is something a CDN in front of the app configures knowingly. The tags
    // ride along so a purge can still name the read the tier keys by.
    cache: { mode: 'no-store', tags: tagKeys(target.cache?.tags ?? []) },
    tags: ['query'],
    // Name AND numbers, exactly as an action's route sets them — the name alone selects a bucket
    // the limiter's table never held, so `bucketFor` falls through to `default` (120 burst, 2/s)
    // and a read declaring 5 runs on 120. `withRouteBuckets` registers the pair at construction.
    // `toBucket` is `@ultimat3/http`'s: the limiter owns the maths, and a copy here would be a
    // second conversion able to publish numbers the limiter refuses.
    ...(target.rateLimit === undefined
      ? {}
      : { rateLimit: name, rateLimitBucket: toBucket(name, target.rateLimit) }),
    ...(target.mcp?.description === undefined ? {} : { description: target.mcp.description }),
  };

  return { method: 'GET', path: derivePath(name), handler, meta };
}

/**
 * The headers this read's `deprecated:` block renders to, or nothing. The successor's URL comes
 * from `derivePath` — the same derivation `client()` uses, never a second one.
 */
function deprecationHeadersFor(
  name: string,
  deprecated: Deprecation | undefined,
): Readonly<Record<string, string>> | undefined {
  if (deprecated === undefined) return undefined;
  const successor =
    deprecated.replacedBy === undefined ? undefined : derivePath(deprecated.replacedBy);
  const rendered = renderDeprecation(deprecated, successor);
  if (!rendered.ok) throw new QueryDeprecationInvalidError(name, rendered.field, rendered.value);
  return rendered.headers;
}
