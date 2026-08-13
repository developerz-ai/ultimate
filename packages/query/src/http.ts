/**
 * Projection: a query becomes `GET /_x/query/<kebab>` — the URL `client.ts` already
 * derives and fetches. The search string is the input, decoded at the wire and judged
 * by `runQuery`, so the endpoint cannot drift from the MCP tool, the live window or a
 * direct server call, and cannot acquire a second authz path while doing it.
 */

import { isUltimateError } from '@ultimat3/core';
import type { Route, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { json, problem } from '@ultimat3/http';
import { coerceQuery } from '@ultimat3/schema';
import { derivePath } from './naming';
import { policyCapability } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName, runQuery } from './read';
import { tagKeys } from './tags';

/**
 * `liveFeed` -> `GET /_x/query/live-feed`. Named for the primitive rather than spelled
 * `toRoute`, because a host mounts this beside `@ultimat3/action`'s and an alias at the
 * import site is a name the reader has to hold — the same reason the tool projection
 * here is `toQueryTool`.
 */
export function toQueryRoute(target: AnyQuery): Route {
  const name = queryName(target);

  const handler = async (request: UltimateRequest): Promise<Response> => {
    try {
      // Coerced, then validated — two different jobs, and only the first one belongs to a
      // wire. A search string is characters, so `t.number` and `t.boolean` need the HTTP
      // boundary's decode (`coerceQuery` never invents data: what it cannot convert it
      // hands on untouched). VALIDATING here — `request.query(schema)` — would be the
      // second parser: the same read would answer `X_BODY_INVALID` where every other
      // surface answers `X_INPUT_INVALID` with the line that prints its schema. `runQuery`
      // is the one that decides, exactly as it does for a direct server call.
      const input = coerceQuery(target.input, request.queryRaw());
      return json(await runQuery(target, input, { surface: 'http' }));
    } catch (error) {
      // Framework errors carry their own code, status and fix line; anything else is
      // a bug and belongs to the server's error boundary, not to this route.
      if (isUltimateError(error)) return problem(error);
      throw error;
    }
  };

  const meta: RouteMeta = {
    name,
    // `allow(...)` is the only way a read is public, and saying so explicitly is what
    // keeps "forgot the policy" from ever looking like "meant to be readable".
    auth: target.policy.kind === 'allow' ? 'public' : 'required',
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
    ...(target.mcp?.description === undefined ? {} : { description: target.mcp.description }),
  };

  return { method: 'GET', path: derivePath(name), handler, meta };
}
