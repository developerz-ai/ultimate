// The generated app's `packages/mcp`: the app's own MCP surface, projected straight from the
// action registry rather than re-listed, plus the test that pins every projected tool describing
// itself.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles } from './scaffold-package-shape';

const DESCRIPTION = "The app's own MCP tools";

/**
 * Writes its own manifest, for the reason `scaffold-i18n.ts` does: `workspacePackageJson` is the
 * dependency-free shape, and this package has a real dependency — `src/index.ts` below imports the
 * app's actions out of `apps/web/api`, because `registerActions` has to see them.
 *
 * The edge points AT the app, which is unusual and correct. `apps/web` is a workspace like any
 * other; reversing it would put the tool catalog upstream of the actions it projects. Declared
 * rather than left to the root tsconfig's `paths`: an undeclared edge resolves for `tsc` and for
 * nothing else — not for `bun --filter` ordering, not for any tool asking what a change affects
 * (`X_WORKSPACE_DEP_UNDECLARED`).
 *
 * `"0.0.0"` and not `workspace:*`: it is the version `apps/web` really carries, which is what
 * `checkLockstep` compares a sibling pin against, and it is the one spelling every other manifest
 * `x new` writes already uses.
 */
const mcpPackage = (app: NameSet): string => `{
  "name": "@${app.kebab}/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "${DESCRIPTION}",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  },
  "dependencies": {
    "@${app.kebab}/web": "0.0.0"
  }
}
`;

const mcpIndex = (
  app: NameSet,
): string => `// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
${sortedImports([
  `import * as api from '@${app.kebab}/web/api/health';`,
  `import { registerActions } from '@ultimat3/action';`,
  `import { defineAppMcp } from '@ultimat3/mcp';`,
])}

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
  { path: 'packages/mcp/package.json', contents: mcpPackage(app) },
  ...packageShapeFiles(app, 'mcp', DESCRIPTION),
  { path: 'packages/mcp/src/index.ts', contents: mcpIndex(app) },
  { path: 'packages/mcp/src/index.test.ts', contents: mcpTest() },
];
