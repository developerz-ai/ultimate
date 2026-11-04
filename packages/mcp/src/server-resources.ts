// `resources/read` — the document surface's three outcomes (hidden = absent, scope, read), every
// one audited, and every provider call inside a `try`. Split from `server.ts` for the size ceiling;
// the server passes what it owns, so this stays a function and never a second dispatcher.

import type { ErrorAudience } from '@ultimat3/core';
import { fixFor } from '@ultimat3/core';
import type { McpAuditor } from './audit-hook';
import { McpScopeDeniedError } from './errors';
import { asFrameworkError, forAudience } from './framework-error';
import type { McpEra } from './protocol-era';
import { resourceNotFoundCode } from './protocol-era';
import type { McpCaller } from './registry';
import type { ResourceRegistry } from './resources';
import type { JsonRpcRequest, JsonRpcResponse } from './wire';
import {
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  paramsOf,
  resultResponse,
} from './wire';

/** What the read needs from the server that owns it. */
export interface ResourceReadDeps {
  readonly resources: ResourceRegistry;
  readonly audit: McpAuditor;
  readonly audience: ErrorAudience;
}

/**
 * The same three-outcome shape `toolsCall` above applies, on the document surface. It took no
 * caller at all until 2026-08: every accepted token could list every URI and read every one of
 * them — the manifest, the OpenAPI document, the route table and the entity schema.
 *
 * And every outcome is AUDITED, hidden included, exactly as `toolsCall`'s are: this method
 * emitted nothing at all, so a URI walk over those four documents was invisible while the same
 * walk over tool names was one `warn` per attempt. `resources/list` stays silent, as
 * `tools/list` does — it is answered pre-filtered.
 */
export async function resourcesRead(
  on: ResourceReadDeps,
  req: JsonRpcRequest,
  caller: McpCaller,
  era: McpEra,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  const uri = paramsOf(req)?.['uri'];
  if (typeof uri !== 'string') {
    return errorResponse(id, INVALID_PARAMS, 'resources/read params.uri must be a string');
  }

  const resolved = on.resources.resolve(uri, caller);
  switch (resolved.kind) {
    // OUTCOME 1. Absent AND hidden collapse to one answer with no `data`: this branch used to
    // return `available: [...every uri]`, so one wrong guess enumerated the whole catalog. No
    // `code` on the audit line either, because the wire carries none — the tool surface's
    // `X_MCP_TOOL_UNKNOWN` is an error class this branch has no twin for.
    case 'not-found':
      on.audit.resourceRead({ uri, outcome: 'hidden', caller });
      return errorResponse(id, resourceNotFoundCode(era), `resource not found: ${uri}`);
    // OUTCOME 2. The caller can already see this resource, so naming the missing scope leaks
    // nothing — and the fix travels with it, built by the error that owns the wording.
    case 'scope-denied': {
      const denial = new McpScopeDeniedError({
        name: uri,
        scope: resolved.scope,
        subject: 'resource',
      });
      on.audit.resourceRead({
        uri,
        outcome: 'scope-denied',
        caller,
        scope: resolved.scope,
        code: denial.code,
      });
      return errorResponse(id, INVALID_REQUEST, `missing scope: ${resolved.scope}`, {
        code: denial.code,
        scope: resolved.scope,
        fix: fixFor(denial, on.audience),
        docs: denial.docs,
      });
    }
    case 'ok':
      break;
  }

  // The provider is an INJECTED THUNK — `frameworkResources` wires these to file reads, and
  // `Bun.file(...).text()` on a missing `x.manifest.json` throws ENOENT. Outside a try it escaped
  // `handle()` entirely: `serveStdio` rejected with the raw error, zero frames written, the
  // request unanswered and every later request on that buffer never processed. Same shape
  // `toolsCall` uses above, for the same reason.
  try {
    const contents = await on.resources.read(uri);
    if (contents === undefined) {
      // The resolver said `ok` and the registry then had nothing: a bug here, not a walk, so it
      // is `failed` in the log while the caller still gets the same not-found it would have.
      on.audit.resourceRead({ uri, outcome: 'failed', caller });
      return errorResponse(id, resourceNotFoundCode(era), `resource not found: ${uri}`);
    }
    on.audit.resourceRead({ uri, outcome: 'ok', caller });
    return resultResponse(id, { contents: [contents] });
  } catch (error) {
    const thrown = asFrameworkError(error);
    if (thrown !== undefined) {
      const framework = forAudience(thrown, on.audience);
      on.audit.resourceRead({ uri, outcome: 'failed', caller, code: framework.code });
      return errorResponse(id, INTERNAL_ERROR, `resource "${uri}" could not be read`, {
        code: framework.code,
        cause: framework.cause,
        fix: fixFor(framework, on.audience),
        ...(framework.docs === undefined ? {} : { docs: framework.docs }),
      });
    }
    // No internals: a provider's own message names a path, a query or a host the caller has no
    // business seeing, exactly as a failing tool's does.
    on.audit.resourceRead({ uri, outcome: 'failed', caller });
    return errorResponse(id, INTERNAL_ERROR, `resource "${uri}" could not be read`);
  }
}
