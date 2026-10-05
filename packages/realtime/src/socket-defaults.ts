// The default ceilings one server socket is built with. Split from `socket.ts` at its size
// ceiling: the socket owns behaviour, this owns the numbers it and `sync-node.ts` agree on.

/**
 * What one socket may ask this node to do per second, and how much of it may arrive at once.
 *
 * The burst clears `DEFAULT_MAX_PER_SOCKET` (128) plus a `hello`, because that is exactly what a
 * legitimate client sends on connect; the sustained rate is well under the ~155 frames/s measured
 * to consume a node through the subscribe path's amplifiers.
 */
export const DEFAULT_MAX_FRAMES_PER_SECOND = 64;
export const DEFAULT_FRAME_BURST = 256;
/**
 * Queued-but-unwritten bytes on one server socket before `send` declines and marks the subscriber
 * desynced. `sync-node.ts` hands the same number to Bun as `backpressureLimit` rather than spelling
 * it again: they are one socket's one buffer, and a check the runtime's own limit fires before is a
 * check that never runs. The client half (`client-mutations.ts`) is deliberately its own constant —
 * it is browser code, and importing this file would pull the node's socket registry into the tab.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
