// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
import * as api from '@social-media-clone/web/api/health';
import { registerActions } from '@ultimat3/action';
import { defineAppMcp } from '@ultimat3/mcp';

// Names come from export names, so the registry agrees with the module the app already wrote.
registerActions(api);

// `include: 'exposed'` projects straight from the registry. Re-listing the actions here would
// copy `mcp: { expose: true }` into a second place, and the copy goes stale in silence.
export const mcp = defineAppMcp({
  name: 'social-media-clone',
  include: 'exposed',
});
