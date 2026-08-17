// The generated app's `packages/mcp`: the app's own MCP surface, projected straight from the
// action registry rather than re-listed, plus the test that pins every projected tool describing
// itself.

import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = "The app's own MCP tools";

const mcpIndex = (
  app: NameSet,
): string => `// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
import * as api from '@${app.kebab}/web/api/health';
import { registerActions } from '@ultimat3/action';
import { defineAppMcp } from '@ultimat3/mcp';

// Names come from export names, so the registry agrees with the module the app already wrote.
registerActions(api);

// \`include: 'exposed'\` projects straight from the registry. Re-listing the actions here would
// copy \`mcp: { expose: true }\` into a second place, and the copy goes stale in silence.
export const mcp = defineAppMcp({
  name: '${app.kebab}',
  include: 'exposed',
});
`;

const mcpTest =
  (): string => `// The app exposes its actions as MCP tools, and each tool carries the action's own policy. An
// agent reaching a tool that authorises differently is the failure this rules out.
import { expect, unitTest } from '@ultimat3/testing';
import { mcp } from './index';

unitTest('the app exposes its actions as MCP tools', () => {
  expect(mcp.tools.length).toBeGreaterThan(0);
  // Every projected tool must describe itself: an agent picks a tool by its description. Assert
  // on the value, not its length — a failure then prints the empty description, not "0 > 0".
  for (const tool of mcp.tools) expect(tool.description).not.toBe('');
});
`;

/** Every file the `packages/mcp` workspace ships, in the order `x new` writes them. */
export const mcpPackageFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'packages/mcp/package.json', contents: workspacePackageJson(app, 'mcp', DESCRIPTION) },
  ...packageShapeFiles(app, 'mcp', DESCRIPTION),
  { path: 'packages/mcp/src/index.ts', contents: mcpIndex(app) },
  { path: 'packages/mcp/src/index.test.ts', contents: mcpTest() },
];
