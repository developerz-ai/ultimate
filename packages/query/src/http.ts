/**
 * Projection: a query becomes `GET /_x/query/<kebab>` — the URL `client.ts` already
 * derives and fetches. The search string is the input, decoded at the wire and judged
 * by `runQuery`, so the endpoint cannot drift from the MCP tool, the live window or a
 * direct server call, and cannot acquire a second authz path while doing it.
 */

import { tagKeys } from '@ultimat3/cache';
import type { Deprecation } from '@ultimat3/core';
import { queryPath, recordDeprecatedCall, renderDeprecation, useContext } from '@ultimat3/core';
import type { RateLimitDecision, Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { publishRateLimit, toBucket } from '@ultimat3/http';
import { admitsAnonymous, policyCapability } from '@ultimat3/policy';
import { coerceQuery } from '@ultimat3/schema';
import { QueryDeprecationInvalidError, QueryInputInvalidError } from './errors';
import { absentArraysOf } from './input-shape';
import { PAGE_FIRST_KEY, pageControlsOf } from './page-controls';
import type { AnyQuery, QueryRateLimit } from './query';
import { queryName, runQuery } from './read';
import { recordAnswerFor, recordRowAnswerFor } from './record-answer';
import { oneRowOf } from './single-answer';

/**
 * `liveFeed` -> `GET /_x/query/live-feed`. Named for the primitive rather than spelled
 * `toRoute`, because a host mounts this beside `@ultimat3/action`'s and an alias at the
 * import site is a name the reader has to hold.
 */
export function toQueryRoute(target: AnyQuery): Route {
  const name = queryName(target);
  // Rendered ONCE, at projection: a date that cannot become a header is a mount-time refusal,
  // not a surprise on the first read.
  const sunsetting = deprecationHeadersFor(name, target.deprecated);
  const answer = recordAnswerFor(target.rows);
  const answerRow = recordRowAnswerFor(target.rows);

  const handler = async (request: UltimateRequest): Promise<Response> => {
    if (sunsetting !== undefined) {
      recordDeprecatedCall('query', name);
      // On the CONTEXT, before anything can fail: the pipeline's `response` stage merges
      // `ctx.headers` into whatever answers — this handler's rows and the `error-map` stage's
      // problem or error page alike. A client polling a deprecated read that is currently 403ing
      // still has to learn the read is going away.
      for (const [header, value] of Object.entries(sunsetting))
        request.ctx.headers.set(header, value);
    }
    // No `catch`: an error — framework or not — takes the path every route's error takes, the
    // repair `@ultimat3/action`'s `toRoute` got. This answered `problem(error)` itself, so the
    // `error-map` stage never saw it: no `onError`/`reportError` on a 5xx, no HTML error page or
    // sign-in redirect for a browser, no `requestId`, no `Retry-After`.
    //
    // Coerced, then validated — two different jobs, and only the first one belongs to a
    // wire. A search string is characters, so `t.number` and `t.boolean` need the HTTP
    // boundary's decode (`coerceQuery` never invents data: what it cannot convert it
    // hands on untouched). VALIDATING here — `request.query(schema)` — would be the
    // second parser: the same read would answer `X_BODY_INVALID` where every other
    // surface answers `X_INPUT_INVALID` with the line that prints its schema. `runQuery`
    // is the one that decides, exactly as it does for a direct server call.
    //
    // The two page controls come OUT first (`page-controls.ts`): they are the route's, not the
    // read's, and a schema that refused unknown keys would otherwise refuse every paged call.
    // The read spends its declared limit itself (`spendReadLimit`, on every surface), keyed on
    // this request's address for an anonymous reader, and hands the decision back for the headers.
    const spending = {
      surface: 'http',
      clientAddress: request.ctx.ip,
      onRateLimit: (decision: RateLimitDecision) =>
        publishRateLimit(request.ctx, decision, useContext().now().getTime()),
    } as const;
    const { input: values, page } = pageControlsOf(name, request.queryRaw());
    const input = absentArraysOf(target.input, coerceQuery(target.input, values));
    if (target.single === true) {
      // Refused, not ignored: a caller paging a read of one object has the wrong read in mind, and
      // a silently dropped `_first` would answer a shape it did not ask for.
      if (page !== undefined) {
        throw new QueryInputInvalidError(
          name,
          `${PAGE_FIRST_KEY} pages a list, and this read is declared single: true — it answers one row, or 404`,
        );
      }
      // The first row — what every in-process `[0]` of the same read already takes. None is the
      // 404 a detail URL means, where a list read answers `200 []`.
      return answerRow(oneRowOf(name, await runQuery(target, input, spending)));
    }
    // With a page control the answer is the `Page` envelope `query.page()` answers a server
    // caller with — `{ rows, nextCursor, hasMore }`, the same names, so a cursor read off the
    // wire and one read off a direct call are the same string in the same field. Without one the
    // answer is the bare array it has always been: every client written before the controls
    // existed keeps reading rows, and `hasMore` never rides on a row where a page marker has no
    // business being.
    return answer(
      page === undefined
        ? await runQuery(target, input, spending)
        : await target.page(input, { ...page, ...spending }),
    );
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
    // Which primitive this is, for `@ultimat3/http`'s bucket check (a bucket named after a query
    // limits nothing since 25.0.0, and is refused rather than ignored).
    primitive: 'query',
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
    // The read spends its own declared bucket on every surface (`read.ts`), so the stage spends
    // no caller bucket here: not this one (the old HTTP-only enforcement point the MCP tool never
    // reached), and not `default` (a ceiling a read declaring more than it never had). The tenant
    // allowance stays the stage's. Refused at mount, never on the first read, when the pair is one
    // the limiter cannot run on: `toBucket` is `@ultimat3/http`'s, so the numbers cannot drift.
    ...(target.rateLimit === undefined
      ? {}
      : { rateLimitedBy: rateLimitedByHandler(name, target.rateLimit) }),
    ...(target.mcp?.description === undefined ? {} : { description: target.mcp.description }),
  };

  return { method: 'GET', path: queryPath(name), handler, meta };
}

/** Validates the declaration through the limiter's own conversion, then hands the route its flag. */
function rateLimitedByHandler(name: string, limit: QueryRateLimit): 'handler' {
  toBucket(name, limit);
  return 'handler';
}

/**
 * The headers this read's `deprecated:` block renders to, or nothing. The successor's URL comes
 * from `queryPath` — the same derivation `client()` uses, never a second one.
 */
function deprecationHeadersFor(
  name: string,
  deprecated: Deprecation | undefined,
): Readonly<Record<string, string>> | undefined {
  if (deprecated === undefined) return undefined;
  const successor =
    deprecated.replacedBy === undefined ? undefined : queryPath(deprecated.replacedBy);
  const rendered = renderDeprecation(deprecated, successor);
  if (!rendered.ok) throw new QueryDeprecationInvalidError(name, rendered.field, rendered.value);
  return rendered.headers;
}
