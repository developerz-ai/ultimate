// The boot-time refusal of an app's MCP MOUNT: several `defineAppMcp` endpoints, one path each.
// The code and title are registered in `errors.ts` with the rest of the package's; the class sits
// apart only so that file stays under the size ceiling (the `meta-errors.ts` precedent).

import { UltimateError } from '@ultimat3/core';

/**
 * Two endpoints resolved to one route. Thrown, never warned: the route table would keep whichever
 * came first, and the population behind the second would be answered with the first's catalog,
 * instructions and scopes — silently, and only for the URL both claimed.
 */
export class McpPathDuplicateError extends UltimateError {
  readonly path: string;
  readonly endpoints: readonly [number, number];

  constructor(input: {
    method: string;
    path: string;
    endpoints: readonly [number, number];
    /** The file exporting endpoint `second` — and `first` too, unless `firstFile` says otherwise. */
    file: string;
    /** The file exporting endpoint `first`, when two app directories' `mcp.ts` collide. */
    firstFile?: string;
  }) {
    const [first, second] = input.endpoints;
    const across = input.firstFile !== undefined && input.firstFile !== input.file;
    super({
      code: 'X_MCP_PATH_DUPLICATE',
      cause: across
        ? `${input.firstFile} (mcp endpoint #${first}) and ${input.file} (mcp endpoint #${second}) both claim ${input.method} ${input.path}`
        : `${input.file} exports mcp endpoints #${first} and #${second}, and both claim ${input.method} ${input.path}`,
      fix: `give endpoint #${second} in ${input.file} its own path — defineAppMcp({ path: '/mcp/<population>', ... }); every endpoint mounts at its own defineAppMcp path (default /mcp)`,
    });
    this.path = input.path;
    this.endpoints = input.endpoints;
  }
}

/**
 * An endpoint's `include: 'exposed'` catalog was projected before the boot scan registered every
 * exposed primitive. Thrown, never warned: served as is, the endpoint lists a smaller catalog than
 * the app declared, and nothing else would ever say so.
 */
export class McpIncludeEarlyError extends UltimateError {
  readonly missing: readonly string[];

  constructor(input: { missing: readonly string[]; file: string }) {
    super({
      code: 'X_MCP_INCLUDE_EARLY',
      cause: `the mcp endpoint ${input.file} exports projected include: 'exposed' before ${input.missing.join(', ')} registered — it was built at the top level of a module the boot scan evaluates before the app's actions and queries — so its catalog lacks them`,
      fix: `build the endpoint at module scope in ${input.file} itself (or a function it calls there) — the boot scan evaluates every apps/<app>/mcp.ts after all apps/*/{site,app,api,shared} modules have registered`,
    });
    this.missing = input.missing;
  }
}
