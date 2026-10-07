// The barrel an app and the gate import. It registers the CLI's own error codes on the way in: no
// command body does any more (they load lazily), and the gate's registry check reads the registry
// through this module — every CLI code read as X_ERROR_CODE_UNREGISTERED when nothing did.

import { expect, test } from 'bun:test';
import { listErrorCodes } from '@ultimat3/core';
import { COMMANDS, SPECS, VERIFY_STEP_NAMES } from './index';

test('importing the barrel registers the CLI codes and hands out the registry', () => {
  const codes = new Set(listErrorCodes().map((entry) => entry.code));
  expect(codes.has('X_CLI_BAD_FLAG')).toBe(true);
  expect(codes.has('X_APP_EMPTY')).toBe(true);
  expect(SPECS.length).toBe(COMMANDS.length);
  expect(VERIFY_STEP_NAMES).toContain('manifest');
});

// 25.0.0 (M3): `nearest` was a second name for core's `nearestName` — one way to do each thing.
test('the barrel carries no `nearest` alias: the one spelling is `nearestName` from core', async () => {
  const barrel: Record<string, unknown> = await import('./index');
  expect(Object.hasOwn(barrel, 'nearest')).toBe(false);
});
