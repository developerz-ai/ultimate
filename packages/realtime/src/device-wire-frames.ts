// The device wire as data: every frame a non-JS client (a firmware, a Go or Rust agent) must read
// or refuse the same way this package does. `scripts/device-wire.ts` generates
// `wire/device-v1.json` from this table; `device-wire-conformance.test.ts` runs it through both
// decoders. Named `-frames`, not `-fixture`: a `*-fixture.ts` is not published, and this is.

import { DEVICE_FRAME_MAX_BYTES, DEVICE_WIRE_VERSION } from './device-wire';

/** `device-to-node` is what `decodeDeviceFrame` reads; `node-to-device` is `decodeNodeFrame`'s. */
export type DeviceWireDirection = 'device-to-node' | 'node-to-device';

export interface DeviceWireFixture {
  readonly name: string;
  readonly direction: DeviceWireDirection;
  /** The exact websocket text frame. */
  readonly text: string;
  /** `false`: a reader must drop the frame, never act on a guess. */
  readonly valid: boolean;
}

const up = (name: string, text: string, valid = true): DeviceWireFixture => ({
  name,
  direction: 'device-to-node',
  text,
  valid,
});
const down = (name: string, text: string, valid = true): DeviceWireFixture => ({
  name,
  direction: 'node-to-device',
  text,
  valid,
});

export const DEVICE_WIRE_FIXTURES: readonly DeviceWireFixture[] = [
  up('beat', '{"type":"beat"}'),
  up('frame', '{"type":"frame","frame":{"temp":21}}'),
  up('frame-null-payload', '{"type":"frame","frame":null}'),
  up('response', '{"type":"response","id":"r_1-A","frame":{"ok":true}}'),
  up('not-json', 'beat', false),
  up('not-an-object', '[1,2]', false),
  up('unknown-type', '{"type":"hello"}', false),
  up('frame-without-payload', '{"type":"frame"}', false),
  up('response-without-id', '{"type":"response","frame":1}', false),
  up('response-id-not-token-safe', '{"type":"response","id":"a b","frame":1}', false),
  up('response-id-too-long', `{"type":"response","id":"${'a'.repeat(65)}","frame":1}`, false),
  down(
    'hello',
    `{"type":"hello","v":1,"heartbeatMs":10000,"maxFrameBytes":${DEVICE_FRAME_MAX_BYTES}}`,
  ),
  down('hello-without-v-reads-as-1', '{"type":"hello","heartbeatMs":10000,"maxFrameBytes":262144}'),
  down(
    'hello-newer-version-decodes',
    `{"type":"hello","v":${DEVICE_WIRE_VERSION + 1},"heartbeatMs":10000,"maxFrameBytes":262144}`,
  ),
  down('hello-v-not-a-number', '{"type":"hello","v":"1","heartbeatMs":1,"maxFrameBytes":1}', false),
  down('hello-v-zero', '{"type":"hello","v":0,"heartbeatMs":1,"maxFrameBytes":1}', false),
  down('hello-v-fractional', '{"type":"hello","v":1.5,"heartbeatMs":1,"maxFrameBytes":1}', false),
  down('hello-without-heartbeat', '{"type":"hello","v":1,"maxFrameBytes":1}', false),
  down('request', '{"type":"request","id":"q-7","frame":{"cmd":"status"}}'),
  down('request-without-id', '{"type":"request","frame":1}', false),
  down('frame', '{"type":"frame","frame":"ack"}'),
  down('frame-without-payload', '{"type":"frame"}', false),
  down('error', '{"type":"error","code":"X_FRAME_RATE_LIMIT"}'),
  down('error-code-not-a-string', '{"type":"error","code":7}', false),
  down('reconnect', '{"type":"reconnect","v":3,"afterMs":2500,"reason":"drain"}'),
  down('reconnect-unknown-reason', '{"type":"reconnect","v":3,"afterMs":1,"reason":"nap"}', false),
  down('reconnect-without-delay', '{"type":"reconnect","v":3,"reason":"drain"}', false),
  down('unknown-type', '{"type":"mutate"}', false),
  down('not-json', '{', false),
];
