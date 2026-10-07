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
    file: string;
  }) {
    const [first, second] = input.endpoints;
    super({
      code: 'X_MCP_PATH_DUPLICATE',
      cause: `${input.file} exports mcp endpoints #${first} and #${second}, and both claim ${input.method} ${input.path}`,
      fix: `give endpoint #${second} in ${input.file} its own path — defineAppMcp({ path: '/mcp/<population>', ... }); every endpoint mounts at its own defineAppMcp path (default /mcp)`,
    });
    this.path = input.path;
    this.endpoints = input.endpoints;
  }
}
