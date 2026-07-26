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

/** The SW listener each capability emits. Used to assert nothing leaks when disabled. */
export const CAPABILITY_SW_MARKERS: Readonly<Record<Capability, readonly string[]>> = Object.freeze(
  {
    push: ["addEventListener('push'", "addEventListener('notificationclick'"],
    backgroundSync: ["addEventListener('sync'"],
    badging: ['navigator.setAppBadge'],
    shareTarget: ['/_x/share-target'],
    fileHandlers: [],
    protocolHandlers: [],
  },
);
