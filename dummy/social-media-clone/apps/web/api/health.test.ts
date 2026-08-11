import { contractTest, expect } from '@ultimat3/testing';
import { health } from './health';

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot `registerActions` stamps the same name onto the same object.
const target = health.named('health');

contractTest('health is an action exposed over MCP', () => {
  expect(target.kind).toBe('action');
  expect(target.mcp?.expose).toBe(true);
});

contractTest('health projects one MCP tool and one OpenAPI operation', () => {
  // Same policy object on both surfaces — a public action says so once, not once per surface.
  expect(target.tool().policy).toBe(target.policy);
  expect(target.openapi().operationId).toBe('health');
});
