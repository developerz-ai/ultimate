// The generated app's `packages/mcp`: the app's own MCP surface, projected straight from the
// action registry rather than re-listed, plus the test that pins every projected tool describing
// itself — and the `apps/web/mcp.ts` endpoint that mounts it (`scaffold-mcp-endpoint.ts`).

import type { GeneratedFile, NameSet } from './naming';
import { mcpEndpointFiles } from './scaffold-mcp-endpoint';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = "The app's own MCP tools";

const mcpIndex = (
  app: NameSet,
): string => `// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
//
// A FUNCTION, and it imports no app (X_BOUNDARY_PACKAGE_TO_APP): \`defineAppMcp\` reads the registry
// where it is called, and \`runRole()\` and \`loadApp()\` both fill that registry before anything
// asks for the catalog. A module-scope call froze whatever had registered by import time.
import { defineAppMcp, type McpRequestFacts, type ResolvedToken } from '@ultimat3/mcp';

/** Who a bearer token is, or \`null\` for nobody — answered 401. */
export type TokenResolver = (
  token: string,
  facts: McpRequestFacts,
) => Promise<ResolvedToken | null> | ResolvedToken | null;

export interface AppMcpOptions {
  /** \`apps/web/mcp.ts\` passes the app's resolver; without one there is no route. */
  readonly resolveToken?: TokenResolver | undefined;
}

// \`include: 'exposed'\` projects straight from the registry. Re-listing the actions here would
// copy \`mcp: { expose: true }\` into a second place, and the copy goes stale in silence.
export const appMcp = (options: AppMcpOptions = {}) =>
  defineAppMcp({
    name: '${app.kebab}',
    include: 'exposed',
    ...(options.resolveToken === undefined ? {} : { resolveToken: options.resolveToken }),
  });
`;

const mcpUnitTest =
  (): string => `// The catalog is built where it is called, from whatever has registered by then: this file loads no
// app, so what it pins is the shape. The tools themselves are the contract test's, next door.
import { expect, unitTest } from '@ultimat3/testing';
import { appMcp } from './index';

unitTest('the catalog is in process until a token resolver is given', () => {
  // No \`resolveToken\` means no route: a mount with no bearer check is the failure this rules out.
  expect(appMcp().route).toBeUndefined();
});

unitTest('given one, it is a route at /mcp', () => {
  expect(appMcp({ resolveToken: () => null }).route?.path).toBe('/mcp');
});
`;

const mcpTest =
  (): string => `// The app exposes its actions as MCP tools, and each tool carries the action's own policy. The
// catalog reads a registry, so the honest proof fills it the way the process does: \`loadApp\` scans
// \`apps/*\` exactly as \`runRole()\` does. Booting the app is the fixture, so the timeout moves.
import { resolve } from 'node:path';
import { loadApp } from '@ultimat3/cli';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';
import { appMcp } from './index';

beforeAll(async () => {
  await loadApp(resolve(import.meta.dir, '../../..'));
}, 30_000);

contractTest('the app exposes its actions as MCP tools', () => {
  const tools = appMcp().tools;
  expect(tools.length).toBeGreaterThan(0);
  // Every projected tool must describe itself: an agent picks a tool by its description. Assert
  // on the value, not its length — a failure then prints the empty description, not "0 > 0".
  for (const tool of tools) expect(tool.description).not.toBe('');
});
`;

/** Every file the `packages/mcp` workspace ships, then the endpoint that mounts it. */
export const mcpPackageFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'packages/mcp/package.json', contents: workspacePackageJson(app, 'mcp', DESCRIPTION) },
  ...packageShapeFiles(app, 'mcp', DESCRIPTION),
  { path: 'packages/mcp/src/index.ts', contents: mcpIndex(app) },
  { path: 'packages/mcp/src/index.test.ts', contents: mcpUnitTest() },
  { path: 'packages/mcp/src/index.contract.test.ts', contents: mcpTest() },
  ...mcpEndpointFiles(app),
];
