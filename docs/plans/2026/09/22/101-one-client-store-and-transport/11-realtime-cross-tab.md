# 11 — One socket per origin: a SharedWorker hosts it

> Part of [`overview.md`](overview.md). Depends on: 03, 09, 10. Tier: 3 (realtime) + 5 (cli emits the worker bundle).

Without this, sockets = open tabs, each counted against the sync node's `AcceptBudget`.

**Decided 2026-09-22: a `SharedWorker` owns the socket**, not a leader tab. The socket lives exactly as long as any tab of the origin does. There is no election, no handover gap when a tab closes, and no `BroadcastChannel` relay to keep consistent. The Web Locks leader design this slice first named is dropped.

## One engine, two hosts
The socket engine (`browser-socket.ts` from slice 06, plus the slice 09/10 subscription and cursor book) talks to tabs **only over a `MessagePort`**, using one protocol.

| Host | When | Port |
|---|---|---|
| `SharedWorker` (`/_x/sync-worker.js`) | `typeof SharedWorker === 'function'` and the constructor does not throw | `worker.port` |
| in-page | `SharedWorker` is absent (some mobile browsers), fails to construct, or the page is inside a sandboxed iframe | `new MessageChannel()`: the engine runs on `port1` in the page, the tab uses `port2` |

This is one mechanism with a transparent fallback, not a second path (axiom 1). The engine and the protocol are the same code under both hosts, so a test of the in-page host tests the worker's logic. The fallback costs one socket per tab and nothing else.

## Protocol (tab ⇄ engine), over the port
| Tab → engine | Engine → tab |
|---|---|
| `hello { scope, protocol }` | `ready`, `state { connection }` |
| `want { channel, params }` / `release { channel, params }` (reference-counted **per port**, then across ports) | `frame { channel, … }`, **routed only to ports that want the channel**. The reference example broadcasts every message to every port; we route |
| `live { queryRef, input }` / `unlive` | `rows` / `patch` for that live registration |
| `ping` every 10 s, `bye` on `pagehide` | `pong` |

- **Dead-port reaping.** A `MessagePort` has no close event, so a closed tab would leak its subscriptions forever; the example has this bug. Rule: `bye` on `pagehide`, and a port silent for 3 pings is reaped. Reaping releases the port's wants, and the engine unsubscribes a channel when no port wants it.
- **Scope.** The worker is keyed by principal: `new SharedWorker(url, { name: 'ultimate-sync:' + scopeHash })`. Two signed-in principals in two tabs get two workers and never share a socket. `rescope` (slice 03) makes the tab `bye` the old worker and `hello` the new one.
- **Store stays per tab.** Solid reactivity is per realm, so each tab's `RecordStore` adopts the frames its port receives. Writes stay per tab over HTTP (slice 08), so the worker never sends a write. Its socket stays read-only (decision 2).
- **Ticket.** The worker mints its socket ticket with `clientTransport` (slice 01) inside the worker realm. That is still the one HTTP seam, loaded in a second realm, so the slice 15 guard allows it by seam file, not by a pin.
- **Resume.** On reconnect the engine re-subscribes the union of wants with each channel's `since` cursor (slice 10). Tabs see no gap, except as a `replay-gap` their store repairs.

## Files to change
- `packages/realtime/src/socket-engine.ts` (new): the engine, host-agnostic. It is fed by a `MessagePort`, owns `browser-socket.ts` and the channel and cursor book, and does per-port reference counting and reaping.
- `packages/realtime/src/sync-worker.ts` (new): the `SharedWorker` entry, `onconnect → engine.attach(port)`. No other code.
- `packages/realtime/src/socket-host.ts` (new): the tab side. It picks the host, sends `hello`, `ping` and `bye`, and gives the page client a port.
- `packages/cli/src/island-bundle.ts`: emits ONE extra browser bundle, `sync-worker.ts`, served at `/_x/sync-worker.js` with an immutable cache hash in the URL. A new deploy gets a new worker, so old tabs keep the old worker until they reload and never talk a mismatched protocol to it. The `hello` protocol check refuses a mismatch with the existing terminal close.
- CSP: `packages/http/src/security-headers.ts:67` already allows `worker-src 'self'`, so there is no change. Add a test that pins it, because this slice now depends on it.

## Steps
1. Engine over a `MessagePort`, tested entirely under the in-page host (`MessageChannel`).
2. Worker entry and the CLI bundle and route.
3. Host selection with fallback, scope naming and reaping.

## Tests
- `socket-engine.test.ts` (in-page `MessageChannel`, fake `WebSocket`):
  - two ports want one channel → one `subscribe` frame;
  - a frame reaches only the ports that want it;
  - one port `bye`s → still subscribed; both `bye` → `unsubscribe`;
  - a silent port is reaped after 3 missed pings;
  - reconnect re-subscribes the union with `since` cursors.
- `socket-host.test.ts`: `SharedWorker` undefined → in-page host; constructor throws → in-page host; a scope change moves to a new worker name.
- `security-headers.test.ts`: `worker-src` includes `'self'`.
- e2e (slice 16), Chromium: two tabs → one `/_x/sync` upgrade. Close one tab → the other stays live **with no reconnect**. That is the property that separates this design from a leader tab.

## Done when
- Two tabs share one socket, and closing either one causes zero reconnects.
- With `SharedWorker` removed (e2e `addInitScript` deletes it), the app still works with one socket per tab.
