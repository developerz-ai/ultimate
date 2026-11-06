// The sync node's upgrade refusal names what the node answered — a status, or no response — so a
// reader looks at a node that never started rather than for a missing query.

import { describe, expect, test } from 'bun:test';
import { LiveNodeUpgradeRefusedError, upgradeRefused } from './errors';

describe('upgradeRefused', () => {
  test('carries the status the node answered with, and its own code', () => {
    const refused = upgradeRefused(503);
    expect(refused).toBeInstanceOf(LiveNodeUpgradeRefusedError);
    expect(refused.code).toBe('X_TEST_LIVE_NODE_UPGRADE_REFUSED');
    expect(refused.cause).toContain('HTTP 503');
    expect(refused.fix).toContain('/_x/sync');
  });

  test('says no response when there was none', () => {
    expect(upgradeRefused(undefined).cause).toContain('answered the upgrade with no response');
  });
});
