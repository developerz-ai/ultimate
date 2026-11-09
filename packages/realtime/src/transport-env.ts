// Single responsibility: environment → fanout transport. The one place a boot
// decides whether this process fans changes out inside its own heap or over NATS, so `x dev`, a
// `sync` container and any custom host resolve it identically. The KV bucket and the presence TTL are decided here too:
// the bucket's whole-stream age limit and `PresenceRegistry`'s TTL are the same number seen from
// two sides, and a caller that had to pass each one separately could quietly set them apart.

import type { Clock } from '@ultimat3/core';
import { finiteOption } from '@ultimat3/core';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import type { NatsConnect } from './nats-client';
import { assertBucket } from './nats-jetstream';
import { NatsTransport } from './nats-transport';
import type { BackoffPolicy } from './thundering-herd';

/**
 * The keys read here, and nothing else. Named once so docs and tests cannot drift from the code.
 * `NATS_URL` set is the bus; unset is the in-process one. Any other bus is `apps/<app>/runtime.ts`'s
 * `transport`, which the boot takes INSTEAD of calling this.
 */
export const TRANSPORT_ENV_KEYS = ['NATS_URL', 'NATS_KV_BUCKET'] as const;

/** Where a bus that is neither NATS nor in-process is handed over. */
const RUNTIME_FILE = 'apps/<app>/runtime.ts';

/**
 * One bucket per deployment, not per cluster: two apps sharing a nats-server would otherwise share
 * one presence namespace, and a room name that collided would list the other app's members.
 */
export const DEFAULT_PRESENCE_BUCKET = 'x_presence';

/** Member TTL. A client heartbeats at a third of it, so one lost beat is never a false leave. */
export const DEFAULT_PRESENCE_TTL_MS = 30_000;

export type TransportEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * What this process does with the bus, which decides whether its boot waits for it:
 *
 * - `'sockets'` — it serves sockets from the bus (a `sync` node). The dial and the presence bucket
 *   are awaited, and a bus that is not there within `connectWithinMs` refuses the boot.
 * - `'feed'` — it feeds those nodes (the replicator). The dial is awaited; it reads no presence,
 *   so it asks JetStream for nothing.
 * - `'publish'` — it only publishes channel events and cache invalidations (`web`, `worker`,
 *   `scheduler`). The dial runs in the background and the boot does not wait: both kinds of
 *   message mean "re-read", and a page that cannot say it is still a page.
 */
export type BusUse = 'sockets' | 'feed' | 'publish';

/** How long a process that cannot work without the bus waits for it before refusing its boot. */
export const BUS_CONNECT_WAIT_MS = 15_000;

const NEEDS: Record<Exclude<BusUse, 'publish'>, string> = {
  sockets: 'serves sockets from the bus',
  feed: 'feeds the sync nodes over the bus',
};

export interface TransportSelection {
  readonly transport: Transport;
  /** `embedded` fans out in this process only; `external` reaches every node on the bus. */
  readonly mode: 'embedded' | 'external';
  /**
   * Why this transport, in one line: the env key that selected it, or what to set to change it.
   * A boot prints it, so "does this process reach the other nodes" is never a guess — and it is
   * the env key rather than the URL, because a NATS url carries credentials.
   */
  readonly detail: string;
  /** Null in embedded mode: nothing is stored on a bus, so there is no bucket to name. */
  readonly bucket: string | null;
  /** What `PresenceRegistry` must be given, so its TTL and the bucket's cannot disagree. */
  readonly presenceTtlMs: number;
  /** What the process does with the bus, as `connect()` and `state()` obey it. */
  readonly use: BusUse;
  /**
   * Dial now rather than on the first change nobody receives. Selection itself stays pure — it
   * parses env and constructs, it does not touch a socket — so a boot can order its dials.
   * Embedded resolves immediately: there is nothing to reach. Under `use: 'publish'` it STARTS the
   * dial and resolves at once; under the other two it resolves connected or rejects with
   * `X_TRANSPORT_UNAVAILABLE` inside `connectWithinMs`.
   */
  connect(): Promise<void>;
  /** `'connecting'` while a NATS bus is not reachable; the in-process bus is always `'up'`. */
  state(): 'up' | 'connecting';
}

export interface SelectTransportOptions {
  readonly presenceTtlMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Injected so a boot — reconnect included — can be proven with no network. */
  readonly connect?: NatsConnect | undefined;
  /** Default `'sockets'`: a caller that does not say is held to the strictest reading. */
  readonly use?: BusUse | undefined;
  /** Default `BUS_CONNECT_WAIT_MS`. Read under `'sockets'` and `'feed'` only. */
  readonly connectWithinMs?: number | undefined;
  /** The dial's retry curve; the transport's own default when unset. */
  readonly backoff?: BackoffPolicy | undefined;
  /** Where the transport's background failures go; its own logger line when unset. */
  readonly onError?: ((error: unknown, subject: string) => void) | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/**
 * The environment decides the default bus: `NATS_URL` set (and not blank) is NATS, unset is the
 * in-process bus. Until 31.0.0 `app.config.ts`'s `realtime.transport`/`urlEnv` decided and the env
 * only had to agree — a closed union no app could add a bus to. A bus of the app's own is
 * `transport` in `apps/<app>/runtime.ts`, and the boot never calls this for it.
 *
 * The one silent failure left — a `sync` node on the in-process bus with its replicator in another
 * process — is refused at boot by the caller, which knows the roles (`X_REALTIME_TOPOLOGY`).
 *
 * The bucket name is validated here rather than on first connect: a typo'd bucket is a boot that
 * reports a healthy bus and then fails every presence write.
 */
export function selectTransport(
  env: TransportEnvironment,
  options: SelectTransportOptions = {},
): TransportSelection {
  const presenceTtlMs = finiteOption(
    'the transport env',
    'presenceTtlMs',
    options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
  );
  const use = options.use ?? 'sockets';
  const url = nonEmpty(env['NATS_URL']);

  if (url === undefined) {
    const transport = new InProcessTransport(
      options.clock === undefined ? {} : { clock: options.clock },
    );
    return {
      transport,
      mode: 'embedded',
      detail: `in-process fanout — set NATS_URL to reach the other nodes, or transport in ${RUNTIME_FILE} for another bus`,
      bucket: null,
      presenceTtlMs,
      use,
      connect: () => Promise.resolve(),
      state: () => 'up',
    };
  }

  const bucket = nonEmpty(env['NATS_KV_BUCKET']) ?? DEFAULT_PRESENCE_BUCKET;
  assertBucket(bucket);
  const transport = new NatsTransport({
    url,
    bucket,
    presenceTtlMs,
    // Only a node that serves presence needs the bucket to exist before it can start.
    presenceBucket: use === 'sockets' ? 'dial' : 'first-use',
    // A publisher without the bus is degraded and still serves; a node that serves FROM it is not.
    outageLevel: use === 'publish' ? 'warn' : 'error',
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const withinMs = finiteOption(
    'the transport env',
    'connectWithinMs',
    options.connectWithinMs ?? BUS_CONNECT_WAIT_MS,
  );
  return {
    transport,
    mode: 'external',
    detail: 'NATS_URL',
    bucket,
    presenceTtlMs,
    use,
    connect: async () => {
      if (use === 'publish') {
        transport.connectInBackground();
        return;
      }
      await transport.connect({
        withinMs,
        // The variable, never the url behind it. `-js` only where the bucket is asked for.
        fix: `x doctor — then check NATS_URL names a reachable nats-server${use === 'sockets' ? ' started with -js (JetStream)' : ''} — this process ${NEEDS[use]} and cannot start without it; the web, worker and scheduler roles boot without one and connect in the background`,
      });
    },
    state: () => (transport.connected ? 'up' : 'connecting'),
  };
}
