// Every `ADAPTER_PORTS` row bound to where this boot honours it, and the ONE install loop over the
// rows (`installPorts`). `PortBindings` is keyed by `AdapterPortName`, so a row core adds without a
// binding is a build error (TS2741). Which value fills a slot — `runtime.ts`'s, else the env
// default — is the caller's one `suppliedOr`.

import { ADAPTER_PORT_NAMES, type AdapterPortName } from '@ultimat3/core';
import type { PortValues } from './runtime-overrides';

/** A port this boot fills: the subset of `ADAPTER_PORTS` that is a `RuntimeOverrides` field. */
export type WiredPort = keyof PortValues;

/** A row with no `RuntimeOverrides` field yet — see `PendingBinding`. */
export type PendingPort = Exclude<AdapterPortName, WiredPort>;

/** What an install answers: the undo, run newest first by the boot's own unwind. */
export type PortRelease = () => void | Promise<void>;

/** The values one phase chose — each one `runtime.ts`'s field or the env default, never both. */
export type ChosenPorts = { readonly [P in WiredPort]?: PortValues[P] | undefined };

/**
 * Installed by the loop, in the phase that owns its dependencies: `boot` ports first, before
 * `app.config.ts` evaluates (its `installSecrets()` asks the secret source); `queue` ports by
 * `startQueue` (`x jobs` boots exactly those); `services` ports by `startServices`, before `loadApp`.
 */
export interface InstalledBinding<P extends WiredPort> {
  readonly phase: InstallPhase;
  /**
   * May be async: an adapter most apps never swap (`aiGateway`, `scrapeDriver`) is imported only
   * when `runtime.ts` supplies one, so no serving role pays for a package it does not use.
   */
  readonly install: (value: PortValues[P]) => PortRelease | Promise<PortRelease>;
}

export type InstallPhase = 'boot' | 'queue' | 'services';

/** Read as a value where it is used, never installed ambiently: `at` names that reader. */
export interface ReadBinding {
  readonly phase: 'read';
  readonly at: string;
}

/**
 * A row with no `RuntimeOverrides` field yet, because the package owning it exposes no installer
 * this boot can call. Stated rather than faked: a field nothing reads is the defect this seam
 * exists to end. `X_ADAPTER_PORT_INCOMPLETE` (slice 21 part B) reports it until `owner` ships one.
 */
export interface PendingBinding {
  readonly phase: 'pending';
  readonly owner: string;
}

export type WiredBindings = { readonly [P in WiredPort]: InstalledBinding<P> | ReadBinding };
export type PendingBindings = { readonly [P in PendingPort]: PendingBinding };
/** Complete over `AdapterPortName`: a new row is a missing key, a removed one an excess key. */
export type PortBindings = WiredBindings & PendingBindings;

/** Every `RuntimeOverrides` port names a real row — a stray key is a build error here. */
const noStrayPorts: [Exclude<WiredPort, AdapterPortName>] extends [never] ? true : never = true;
void noStrayPorts;

/** The wired keys as a value, so the loop can narrow a row's name. Complete by its type. */
const WIRED: { readonly [P in WiredPort]: true } = {
  aiGateway: true,
  auditSink: true,
  authLimiter: true,
  authServerStore: true,
  cacheTiers: true,
  clock: true,
  errorReporter: true,
  eventBus: true,
  failureStore: true,
  idempotencyStore: true,
  images: true,
  isrStore: true,
  jobs: true,
  mail: true,
  mcpConfirmationStore: true,
  meterStore: true,
  notifyStores: true,
  outboxStore: true,
  purge: true,
  pushSubscriptionStore: true,
  rateLimitStore: true,
  scrapeDriver: true,
  secretSource: true,
  storage: true,
  totpReplay: true,
  transport: true,
};

/** Whether a row is a `RuntimeOverrides` field — the scaffold marks the rest as pending. */
export const isWired = (port: string): port is WiredPort => Object.hasOwn(WIRED, port);

/** Generic so the binding's parameter and the chosen value are the SAME port's type. */
function installOne<P extends WiredPort>(
  binding: WiredBindings[P],
  port: P,
  phase: InstallPhase,
  chosen: ChosenPorts,
): PortRelease | Promise<PortRelease> | undefined {
  if (binding.phase !== phase) return undefined;
  const value: PortValues[P] | undefined = chosen[port];
  // Absent: a port this phase builds no default for (`notifyStores`, `auditSink`), so the
  // package's own default stands — which is the env default its row documents.
  return value === undefined ? undefined : binding.install(value);
}

/**
 * Install every port `phase` owns, in `ADAPTER_PORTS` order, and answer the releases in that order
 * — the caller's unwind runs them newest first. The ONE place a backend becomes ambient. `bindings`
 * is the full `PORT_BINDINGS`, or one phase's slice where loading the rest would weigh down a light
 * boot (`runtime-port-bindings-queue.ts`).
 */
export async function installPorts(
  bindings: { readonly [P in WiredPort]?: WiredBindings[P] },
  phase: InstallPhase,
  chosen: ChosenPorts,
): Promise<PortRelease[]> {
  const releases: PortRelease[] = [];
  try {
    for (const port of ADAPTER_PORT_NAMES) {
      if (!isWired(port)) continue;
      const binding = bindings[port];
      if (binding === undefined) continue;
      // In order, one at a time: a later port may read an earlier one (the clock before the rest).
      const release = await installOne(binding, port, phase, chosen);
      if (release !== undefined) releases.push(release);
    }
  } catch (error) {
    // A port that would not install (an adapter module that failed to load) must not strand the
    // ones before it: released newest first, each tried, and the install's rejection is the cause.
    for (const release of releases.reverse()) {
      try {
        await release();
      } catch {
        // Cleanup noise never replaces the install failure.
      }
    }
    throw error;
  }
  return releases;
}

/** A port's value, and the default the boot BUILT for it — `undefined` when `runtime.ts` supplied it. */
export interface Chosen<T, O extends T> {
  readonly value: T;
  readonly own: O | undefined;
}

/**
 * `runtime.ts`'s value, else the env default — built only when needed, and kept apart so the
 * retention sweep expires the boot's own tables and never a store the app handed over.
 */
export function suppliedOr<T, O extends T>(supplied: T | undefined, build: () => O): Chosen<T, O> {
  if (supplied !== undefined) return { value: supplied, own: undefined };
  const own = build();
  return { value: own, own };
}
