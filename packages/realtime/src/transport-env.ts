// Single responsibility: environment → fanout transport. The one place a boot decides whether this
// process fans changes out inside its own heap or over NATS, so `x dev`, a `sync` container and any
// custom host resolve it identically. The KV bucket and the presence TTL are decided here too:
// the bucket's whole-stream age limit and `PresenceRegistry`'s TTL are the same number seen from
// two sides, and a caller that had to pass each one separately could quietly set them apart.

import type { Clock } from '@ultimat3/core';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import type { NatsConnect } from './nats-client';
import { assertBucket } from './nats-jetstream';
import { NatsTransport } from './nats-transport';

/** The keys read here, and nothing else. Named once so docs and tests cannot drift from the code. */
export const TRANSPORT_ENV_KEYS = ['NATS_URL', 'NATS_KV_BUCKET'] as const;

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
 * No url means the in-process transport — the same "an unset variable means the embedded default"
 * law the db, mail, storage and replication bindings follow. The bucket name is validated here
 * rather than on first connect: a typo'd bucket is a boot that reports a healthy bus and then
 * fails every presence write, which is the failure this whole selector exists to move earlier.
 */
export function selectTransport(
  env: TransportEnvironment,
  options: SelectTransportOptions = {},
): TransportSelection {
  const presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
  const url = nonEmpty(env['NATS_URL']);

  if (url === undefined) {
    const transport = new InProcessTransport(
      options.clock === undefined ? {} : { clock: options.clock },
    );
    return {
      transport,
      mode: 'embedded',
      detail: 'in-process fanout — set NATS_URL to reach the other nodes',
      bucket: null,
      presenceTtlMs,
      connect: () => Promise.resolve(),
    };
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
    detail: 'NATS_URL',
    bucket,
    presenceTtlMs,
    connect: () => transport.connect(),
  };
}
