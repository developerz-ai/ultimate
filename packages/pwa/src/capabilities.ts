/**
 * The opt-in capability flags from `app.config.ts`. Each flag gates BOTH the manifest
 * entry and the service-worker code, so a capability you did not ask for ships zero
 * bytes and requests zero permissions.
 */

export const CAPABILITIES = [
  'push',
  'backgroundSync',
  'badging',
  'shareTarget',
  'fileHandlers',
  'protocolHandlers',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityFlags = { readonly [K in Capability]?: boolean };
export type ResolvedCapabilities = Readonly<Record<Capability, boolean>>;

/** Everything is off unless the app turns it on. */
export function resolveCapabilities(flags: CapabilityFlags = {}): ResolvedCapabilities {
  const resolved: Record<Capability, boolean> = {
    push: false,
    backgroundSync: false,
    badging: false,
    shareTarget: false,
    fileHandlers: false,
    protocolHandlers: false,
  };
  for (const capability of CAPABILITIES) {
    resolved[capability] = flags[capability] === true;
  }
  return resolved;
}

export function isEnabled(capabilities: ResolvedCapabilities, capability: Capability): boolean {
  return capabilities[capability];
}

export function enabledCapabilities(capabilities: ResolvedCapabilities): readonly Capability[] {
  return CAPABILITIES.filter((capability) => capabilities[capability]);
}

/** Manifest members a capability owns. Absent capability → absent member. */
export const CAPABILITY_MANIFEST_KEYS: Readonly<Record<Capability, readonly string[]>> =
  Object.freeze({
    push: [],
    backgroundSync: [],
    badging: [],
    shareTarget: ['share_target'],
    fileHandlers: ['file_handlers'],
    protocolHandlers: ['protocol_handlers'],
  });

/**
 * The service-worker code each capability emits — its listener, and anything that listener alone
 * needs. Checked in BOTH directions (`service-worker.test.ts`): every marker is in the emitted
 * worker when its capability is on, and none of them is when they are all off. `PwaSyncError` is
 * the background-sync handler's own error class, so it ships with the handler and never without it.
 *
 * An EMPTY list is a claim too, and the true one for the three manifest-only capabilities: a share
 * target, a file handler and a protocol handler are all delivered by the OS to a URL the app
 * already serves, so the member is the whole feature and the worker has no branch to add.
 * `shareTarget` named `/_x/share-target` here for two releases and no block ever emitted it.
 */
export const CAPABILITY_SW_MARKERS: Readonly<Record<Capability, readonly string[]>> = Object.freeze(
  {
    push: ["addEventListener('push'", "addEventListener('notificationclick'"],
    backgroundSync: ["addEventListener('sync'", 'class PwaSyncError'],
    badging: ['navigator.setAppBadge'],
    shareTarget: [],
    fileHandlers: [],
    protocolHandlers: [],
  },
);
