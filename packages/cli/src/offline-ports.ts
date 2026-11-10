// `apps/<app>/runtime.ts` for the two paths that run the app's primitives with no server — `x build`'s
// renders and `x exercise`'s pass — read and installed by the boot's own reader and loop, with
// every port first decided by `OFFLINE_PORTS`: a memory double, or the package default.

// Why a table and not the app's values: neither path may reach a deployment's backend. A port with
// no row is a build error (TS2741 on `OfflinePortTable`).

import { memoryAuditSink } from '@ultimat3/action';
import { loadAppRuntime } from './app-runtime';
import type { PortValues, RuntimeOverrides } from './runtime-overrides';
import { PORT_BINDINGS } from './runtime-port-bindings';
import type { ChosenPorts, WiredPort } from './runtime-ports';
import { installPorts } from './runtime-ports';

/**
 * What an offline path does with a port `runtime.ts` supplied. `double`: install this stand-in in
 * the app's place — the port's presence is what the primitive asks, and the app's own backend may
 * be production's. `default`: install nothing, so the package's own default answers; `why` says so.
 */
export type OfflineChoice<P extends WiredPort> =
  | { readonly use: 'double'; readonly double: () => PortValues[P] }
  | { readonly use: 'default'; readonly why: string };

export type OfflinePortTable = { readonly [P in WiredPort]: OfflineChoice<P> };

const remote = (why: string) => ({ use: 'default', why }) as const;
const NETWORK = remote('a remote backend; the package default (memory or a refusal) answers');
const POOL = remote('Postgres over the ambient pool by default: the scratch or measure database');
const BOOT = remote('a boot-phase port; the offline paths keep the process their command set up');
const SERVED = remote('read by the serving boot only; no request is served offline');

/**
 * One row per wired port. Only `services`-phase ports can be doubles: `installPorts` installs that
 * phase alone (`offline-ports.test.ts` holds it).
 */
export const OFFLINE_PORTS: OfflinePortTable = {
  aiGateway: NETWORK,
  // Its presence is the contract: `audit: true` is refused without one (`X_AUDIT_SINK_MISSING`), so
  // an app that declared one runs; where the records go is the deployment's, never a build's.
  auditSink: { use: 'double', double: () => memoryAuditSink() },
  authLimiter: POOL,
  authServerStore: POOL,
  cacheTiers: SERVED,
  clock: BOOT,
  embedder: NETWORK,
  errorReporter: remote('an offline failure is the command`s finding, never a production report'),
  eventBus: POOL,
  failureStore: SERVED,
  idempotencyStore: POOL,
  images: SERVED,
  isrStore: SERVED,
  jobs: POOL,
  mail: NETWORK,
  mcpConfirmationStore: POOL,
  meterStore: POOL,
  notifyStores: POOL,
  outboxStore: POOL,
  purge: NETWORK,
  pushSubscriptionStore: POOL,
  rateLimitStore: POOL,
  scrapeDriver: NETWORK,
  searchIndex: POOL,
  secretSource: BOOT,
  semanticCache: NETWORK,
  smsTransport: NETWORK,
  storage: remote('`x exercise` stands in a memory disk (`exercise-services.ts`)'),
  totpReplay: POOL,
  transport: NETWORK,
  uploadScanner: NETWORK,
};

/** The doubles for the ports `runtime` supplied; an absent port stays absent, as at a real boot. */
export function offlineChosen(
  runtime: RuntimeOverrides | undefined,
  table: OfflinePortTable = OFFLINE_PORTS,
): ChosenPorts {
  const chosen: { [P in WiredPort]?: PortValues[P] } = {};
  const pick = <P extends WiredPort>(port: P): void => {
    const choice: OfflineChoice<P> = table[port];
    if (choice.use === 'double' && runtime?.[port] !== undefined) chosen[port] = choice.double();
  };
  for (const port of Object.keys(table) as WiredPort[]) pick(port);
  return chosen;
}

/** Install the offline ports for the app at `root`; answers the release, newest first. */
export async function installOfflinePorts(root: string): Promise<() => Promise<void>> {
  const releases = await installPorts(
    PORT_BINDINGS,
    'services',
    offlineChosen(await loadAppRuntime(root)),
  );
  return async () => {
    for (const release of releases.toReversed()) await release();
  };
}

/** `work` with the offline ports installed, released however it ends. */
export async function withOfflinePorts<T>(root: string, work: () => Promise<T>): Promise<T> {
  const release = await installOfflinePorts(root);
  try {
    return await work();
  } finally {
    await release();
  }
}
