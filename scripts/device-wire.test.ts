// `--check` is red on a missing or edited file and green on the generated one.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { deviceWireDrift, deviceWireFindings, renderDeviceWire } from './device-wire';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · device-wire --check', () => {
  test('the committed file is the generated one', async () => {
    expect(await deviceWireFindings(repoRoot())).toEqual([]);
  });

  test('a matching file passes', () => {
    expect(deviceWireDrift(renderDeviceWire())).toEqual([]);
  });

  test('a missing file and an edited one both drift, with the write command as the fix', () => {
    for (const text of ['', renderDeviceWire().replace('beat', 'bat')]) {
      const [finding, ...rest] = deviceWireDrift(text);
      expect(rest).toEqual([]);
      expect(finding?.code).toBe('X_DEVICE_WIRE_DRIFT');
      expect(finding?.fix).toBe('bun run scripts/device-wire.ts --write');
    }
  });
});
