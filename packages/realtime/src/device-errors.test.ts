// A refusal's `fix:` is a call to paste, so the deadline it prints must be one `request()` accepts:
// doubling a deadline already past half the ceiling printed a call that throws X_CONFIG_INVALID.

import { describe, expect, test } from 'bun:test';
import { DeviceRequestTimeoutError } from './device-errors';

const fixFor = (deadlineMs: number): string =>
  new DeviceRequestTimeoutError({ path: '/link', deviceId: 'dev-1', deadlineMs }).fix;

describe('unit · X_DEVICE_REQUEST_TIMEOUT fix', () => {
  test('doubles a short deadline', () => {
    expect(fixFor(30_000)).toContain('{ deadlineMs: 60000 }');
  });

  test('never suggests a deadline past the 600000ms ceiling', () => {
    expect(fixFor(400_000)).toContain('{ deadlineMs: 600000 }');
    expect(fixFor(600_000)).toContain('{ deadlineMs: 600000 }');
  });
});
