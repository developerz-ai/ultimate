// Every published device-wire fixture through the decoder for its direction: a valid frame decodes
// and survives a round trip, a rejected one is `undefined`. Also pins the version rules.

import { describe, expect, test } from 'bun:test';
import { DEVICE_WIRE_VERSION, decodeDeviceFrame, decodeNodeFrame } from './device-wire';
import { DEVICE_WIRE_FIXTURES } from './device-wire-frames';

const decode = (direction: string, text: string): unknown =>
  direction === 'device-to-node' ? decodeDeviceFrame(text) : decodeNodeFrame(text);

describe('unit · device wire conformance', () => {
  test('fixture names are unique per direction, and both outcomes are covered', () => {
    const keys = DEVICE_WIRE_FIXTURES.map((f) => `${f.direction}/${f.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DEVICE_WIRE_FIXTURES.some((f) => !f.valid)).toBe(true);
    expect(DEVICE_WIRE_FIXTURES.some((f) => f.valid)).toBe(true);
  });

  for (const fixture of DEVICE_WIRE_FIXTURES) {
    test(`${fixture.direction} · ${fixture.name} is ${fixture.valid ? 'read' : 'refused'}`, () => {
      const decoded = decode(fixture.direction, fixture.text);
      if (!fixture.valid) {
        expect(decoded).toBeUndefined();
        return;
      }
      expect(decoded).toBeDefined();
      expect(decode(fixture.direction, JSON.stringify(decoded))).toEqual(decoded);
    });
  }

  test('a hello with no v reads as version 1; the node always sends v', () => {
    expect(decodeNodeFrame('{"type":"hello","heartbeatMs":1,"maxFrameBytes":2}')).toEqual({
      type: 'hello',
      v: 1,
      heartbeatMs: 1,
      maxFrameBytes: 2,
    });
    expect(DEVICE_WIRE_VERSION).toBe(1);
  });
});
