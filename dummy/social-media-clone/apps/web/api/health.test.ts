import { contractTest, expect } from '@ultimat3/testing';
import { health } from './health';

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot `registerActions` stamps the same name onto the same object.
const target = health.named('health');

contractTest('health is an action exposed over MCP', () => {
  expect(target.kind).toBe('action');
  expect(target.mcp?.expose).toBe(true);
});

contractTest('health projects one OpenAPI operation under its export name', () => {
  // The MCP tool is `@ultimat3/mcp`'s `toolFrom`, served from the same `mcp` block above.
  expect(target.openapi().operationId).toBe('health');
});
