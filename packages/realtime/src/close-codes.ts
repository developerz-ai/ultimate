// The close codes this protocol speaks, defined once below both halves. `socket.ts` (the node's
// registry) and `client-frames.ts` (browser code) each need one of these and neither may import
// the other — the client must not pull the node's registry into the tab — so the table lives here,
// a leaf with no import at all, and `socket.ts` re-exports it for the node-side files that already
// read `CLOSE` from there.
//
// 1000–1015 are the RFC 6455 codes; 4000–4999 are private use. A browser accepts only 1000 and
// 3000–4999 from script (`WebSocket.close()` throws `InvalidAccessError` on anything else), which
// is why every code the CLIENT sends is in the private range and why `goingAway` (1001) is a code
// only the node may close with.

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  policy: 1008,
  overloaded: 1013,
  versionSkew: 4000,
  idle: 4001,
  /** The node drains, or the client obeys a `reconnect` frame: one event, one code, either side. */
  drain: 4002,
} as const;
