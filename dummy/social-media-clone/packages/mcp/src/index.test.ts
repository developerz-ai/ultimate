import { expect, unitTest } from '@ultimat3/testing';
import { mcp } from './index';

unitTest('the app exposes its actions as MCP tools', () => {
  expect(mcp.tools.length).toBeGreaterThan(0);
  // Every projected tool must describe itself: an agent picks a tool by its description. Assert
  // on the value, not its length — a failure then prints the empty description, not "0 > 0".
  for (const tool of mcp.tools) expect(tool.description).not.toBe('');
});
