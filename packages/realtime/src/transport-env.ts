// Single responsibility: `realtime.transport` + environment → fanout transport. The one place a boot
// decides whether this process fans changes out inside its own heap or over NATS, so `x dev`, a
// `sync` container and any custom host resolve it identically. The KV bucket and the presence TTL are decided here too:
// the bucket's whole-stream age limit and `PresenceRegistry`'s TTL are the same number seen from
// two sides, and a caller that had to pass each one separately could quietly set them apart.

import type { Clock, RealtimeConfig } from '@ultimat3/core';
import { ConfigInvalidError, finiteOption } from '@ultimat3/core';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import type { NatsConnect } from './nats-client';
import { assertBucket } from './nats-jetstream';
import { NatsTransport } from './nats-transport';

/**
 * The keys read here, and nothing else. Named once so docs and tests cannot drift from the code.
 * `NATS_URL` is the conventional bus variable: read under `transport: 'nats'` when `urlEnv` names
 * it, and under `'memory'` only to refuse it — see `selectTransport`.
 */
export const TRANSPORT_ENV_KEYS = ['NATS_URL', 'NATS_KV_BUCKET'] as const;

/** The two fields of `app.config.ts`'s `realtime` section that decide the bus. */
export type RealtimeTopology = Pick<RealtimeConfig, 'transport' | 'urlEnv'>;

/** Named in every refusal, so the reader edits the file the decision lives in. */
const CONFIG_FILE = 'app.config.ts';

/**
 * One bucket per deployment, not per cluster: two apps sharing a nats-server would otherwise share
 * one presence namespace, and a room name that collided would list the other app's members.
 */
export const DEFAULT_PRESENCE_BUCKET = 'x_presence';

/** Member TTL. A client heartbeats at a third of it, so one lost beat is never a false leave. */
export const DEFAULT_PRESENCE_TTL_MS = 30_000;

export type TransportEnvironment = Readonly<Record<string, string | undefined>>;

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
  /**
   * Dial now rather than on the first change nobody receives. Selection itself stays pure — it
   * parses env and constructs, it does not touch a socket — so a boot can order its dials.
   * Embedded resolves immediately: there is nothing to reach.
   */
  connect(): Promise<void>;
}

export interface SelectTransportOptions {
  readonly presenceTtlMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Injected so a boot — reconnect included — can be proven with no network. */
  readonly connect?: NatsConnect | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/**
 * The config decides the transport and the environment supplies its url — never the other way
 * round. Until 22.0.0 `NATS_URL` alone decided and `realtime.transport` / `realtime.urlEnv` were
 * read by nothing, so `transport: 'nats'` with the variable unset booted the in-process bus and
 * reached no other node, with no error on either side. Both mismatches are refused here:
 *
 * - `'nats'` with the variable `urlEnv` names unset or blank.
 * - `'memory'` with a bus url set (`NATS_URL`, or the variable `urlEnv` names). An operator who set
 *   one expected fanout across nodes; keeping every change in this heap instead is the same silent
 *   failure seen from the other side, so the two are refused rather than reconciled.
 *
 * The bucket name is validated here rather than on first connect: a typo'd bucket is a boot that
 * reports a healthy bus and then fails every presence write.
 */
export function selectTransport(
  env: TransportEnvironment,
  topology: RealtimeTopology,
  options: SelectTransportOptions = {},
): TransportSelection {
  const presenceTtlMs = finiteOption(
    'the transport env',
    'presenceTtlMs',
    options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
  );

  if (topology.transport === 'memory') {
    refuseStrayBusUrl(env, topology);
    const transport = new InProcessTransport(
      options.clock === undefined ? {} : { clock: options.clock },
    );
    return {
      transport,
      mode: 'embedded',
      detail: `in-process fanout — set realtime.transport 'nats' in ${CONFIG_FILE} and NATS_URL to reach the other nodes`,
      bucket: null,
      presenceTtlMs,
      connect: () => Promise.resolve(),
    };
  }

  const urlEnv = topology.urlEnv ?? 'NATS_URL';
  const url = nonEmpty(env[urlEnv]);
  if (url === undefined) {
    throw new ConfigInvalidError({
      cause: `realtime.transport is 'nats' and realtime.urlEnv names ${urlEnv}, which is unset in this process's environment, so no node would be reachable`,
      fix: `set ${urlEnv} to the nats-server url for every realtime role (web, sync, replicator), or set realtime: { transport: 'memory' } in ${CONFIG_FILE} for a single node`,
      meta: { key: 'realtime.urlEnv', variable: urlEnv },
    });
  }

  const bucket = nonEmpty(env['NATS_KV_BUCKET']) ?? DEFAULT_PRESENCE_BUCKET;
  assertBucket(bucket);
  const transport = new NatsTransport({
    url,
    bucket,
    presenceTtlMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
  });
  return {
    transport,
    mode: 'external',
    detail: urlEnv,
    bucket,
    presenceTtlMs,
    connect: () => transport.connect(),
  };
}

/** `'memory'` with a bus url in the environment: the conflict `selectTransport` refuses. */
function refuseStrayBusUrl(env: TransportEnvironment, topology: RealtimeTopology): void {
  const names = topology.urlEnv === undefined ? ['NATS_URL'] : ['NATS_URL', topology.urlEnv];
  const set = names.find((name) => nonEmpty(env[name]) !== undefined);
  if (set === undefined) return;
  throw new ConfigInvalidError({
    cause: `${set} is set but realtime.transport is 'memory', so this process would fan out in its own heap and reach no other node`,
    fix: `set realtime: { transport: 'nats', urlEnv: '${set}' } in ${CONFIG_FILE} to use the bus, or unset ${set} for a single node`,
    meta: { key: 'realtime.transport', variable: set },
  });
}
