// Every capability is off unless the app asks for it, and the resolved record is what both the
// manifest and the worker gate on. A flag that resolves truthy from anything other than `true`
// would ship permissions an app never opted into.

import { describe, expect, test } from 'bun:test';
import type { CapabilityFlags } from './capabilities';
import {
  CAPABILITIES,
  CAPABILITY_MANIFEST_KEYS,
  CAPABILITY_SW_MARKERS,
  enabledCapabilities,
  isEnabled,
  resolveCapabilities,
} from './capabilities';

describe('resolveCapabilities', () => {
  test('answers every declared capability, all off, when the app configures nothing', () => {
    const resolved = resolveCapabilities();

    expect(Object.keys(resolved).sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.values(resolved)).toEqual(CAPABILITIES.map(() => false));
    expect(enabledCapabilities(resolved)).toEqual([]);
  });

  test('only a literal true turns a capability on', () => {
    // `1` and `'yes'` are what a JSON config or an env-derived flag arrives as.
    const flags = { push: 1, badging: 'yes', backgroundSync: true } as unknown as CapabilityFlags;
    const resolved = resolveCapabilities(flags);

    expect(isEnabled(resolved, 'push')).toBe(false);
    expect(isEnabled(resolved, 'badging')).toBe(false);
    expect(isEnabled(resolved, 'backgroundSync')).toBe(true);
  });

  test('enabledCapabilities lists exactly the ones that are on, in declaration order', () => {
    const resolved = resolveCapabilities({ protocolHandlers: true, push: true, badging: true });

    expect(enabledCapabilities(resolved)).toEqual(['push', 'badging', 'protocolHandlers']);
  });
});

describe('the two capability tables', () => {
  test('both name every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_MANIFEST_KEYS).sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.keys(CAPABILITY_SW_MARKERS).sort()).toEqual([...CAPABILITIES].sort());
  });

  test('a capability owns bytes on at least one surface — a table entry cannot be empty twice', () => {
    for (const capability of CAPABILITIES) {
      const surfaces =
        CAPABILITY_MANIFEST_KEYS[capability].length + CAPABILITY_SW_MARKERS[capability].length;
      expect({ capability, surfaces: surfaces > 0 }).toEqual({ capability, surfaces: true });
    }
  });

  test('the manifest-only capabilities declare no worker marker', () => {
    // `shareTarget` named `/_x/share-target` here while no block ever emitted it.
    expect(CAPABILITY_SW_MARKERS.shareTarget).toEqual([]);
    expect(CAPABILITY_SW_MARKERS.fileHandlers).toEqual([]);
    expect(CAPABILITY_SW_MARKERS.protocolHandlers).toEqual([]);
  });
});
