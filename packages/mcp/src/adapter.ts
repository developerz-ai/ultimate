// `@ultimat3/mcp/adapter`: the `mcpConfirmationStore` port (`ADAPTER_PORTS`) — the interface a store
// implements, the error it raises on a lost race, and the installer with its reset. Never on the `.`
// barrel: the boot (`apps/<app>/runtime.ts`) and `@ultimat3/testing` are the callers. The shipped
// stores (`memoryConfirmationStore`, `postgresConfirmationStore`) stay on `.`.

export { McpConfirmationContestedError } from './confirmation-errors';
export {
  installConfirmationStore,
  installedConfirmationStore,
  resetConfirmationStore,
} from './confirmation-installed';
export type {
  McpConfirmation,
  McpConfirmationApproval,
  McpConfirmationDraft,
  McpConfirmationStatus,
  McpConfirmationStore,
} from './confirmation-store';
