// Single responsibility: the fanout bus as ONE boot holds it — what the roles it starts do with
// the bus, the dial that calls for, the readiness check, and the label the boot line prints.
//
// The rule is the role's, not the transport's. A `sync` node serves sockets from the bus and a
// replicator feeds them: neither can work without it, so each awaits the dial and refuses its
// boot, coded, inside a bounded wait. `web`, `worker` and `scheduler` only PUBLISH — channel
// events and cache invalidations, both of which mean "re-read" — so for them the bus is dialled in
// the background and a dead one is `degraded`: the pod still boots, serves and runs jobs. Until
// 2026-10 every role awaited the dial and the JetStream bucket, so a web pod that restarted while
// NATS was down took the app's pages, webhooks and send jobs down with a feature none of them use.

import type { RealtimeConfig, Role } from '@ultimat3/core';
import { logger, registerReadinessCheck } from '@ultimat3/core';
import type { BusUse, SelectTransportOptions, Transport } from '@ultimat3/realtime/server';
import { selectTransport, setChannelTransport } from '@ultimat3/realtime/server';
import type { Env } from './runtime-bindings';

/**
 * What a process running `roles` does with the bus. `undefined` — a boot that names no roles — is
 * held to the strictest reading, the one every boot had. `realtime.enabled: false` starts neither
 * realtime role (`role-realtime.ts`), so nothing in such a process waits for the bus.
 */
export function busUseFor(
  roles: readonly Role[] | undefined,
  realtime: Pick<RealtimeConfig, 'enabled'>,
): BusUse {
  if (roles === undefined) return 'sockets';
  if (!realtime.enabled) return 'publish';
  if (roles.includes('sync')) return 'sockets';
  return roles.includes('replicator') ? 'feed' : 'publish';
}

/** A transport that says whether it is connected. NATS does; the in-process bus has nothing to be. */
interface ConnectableTransport {
  readonly connected: boolean;
}

const saysConnected = (transport: Transport): transport is Transport & ConnectableTransport =>
  typeof (transport as Partial<ConnectableTransport>).connected === 'boolean';

/**
 * The boot line's `bus=` value: `nats(up)`, `nats(connecting)`, or the bare name of a bus with no
 * connection to lose. A fixed vocabulary a script may parse, never a catalog lookup.
 */
export function busLabel(transport: Transport): string {
  if (!saysConnected(transport)) return transport.name;
  return `${transport.name}(${transport.connected ? 'up' : 'connecting'})`;
}

export interface RunningBus {
  readonly transport: Transport;
  /** The env key that selected the bus — never the url behind it — or `runtime override`. */
  readonly detail: string;
  /** Everything `start()` acquired, newest first; the first failure is rethrown, every step runs. */
  stop(): Promise<void>;
}

export interface SelectedBus {
  readonly use: BusUse;
  /** What the sync role must give `PresenceRegistry` (`RunningServices.presenceTtlMs`). */
  readonly presenceTtlMs: number;
  /**
   * Dial as `use` calls for, install the transport as the process's channel bus, and register its
   * readiness check. Rejects — with nothing left registered or open — only for a use that cannot
   * work without the bus.
   */
  start(): Promise<RunningBus>;
}

export interface SelectBusInput {
  readonly env: Env;
  readonly realtime: RealtimeConfig;
  /** The roles this process will start; `undefined` when the caller does not know. */
  readonly roles: readonly Role[] | undefined;
  /** `RuntimeOverrides.transport`: already connected, and its owner's to close. */
  readonly override?: Transport | undefined;
  /** Injected by a test: a fake dial, a short wait. */
  readonly select?: SelectTransportOptions | undefined;
}

/**
 * Selection is pure — it parses env and constructs, it dials nothing — so a config and an
 * environment that disagree refuse here, before any service starts (`selectTransport`).
 */
export function selectBus(input: SelectBusInput): SelectedBus {
  const use = busUseFor(input.roles, input.realtime);
  const selection = selectTransport(input.env, input.realtime, { ...input.select, use });
  return {
    use,
    presenceTtlMs: selection.presenceTtlMs,
    async start(): Promise<RunningBus> {
      const started: (() => void | Promise<void>)[] = [];
      const stop = async (): Promise<void> => {
        let failure: { readonly error: unknown } | undefined;
        for (const step of started.splice(0).reverse()) {
          try {
            await step();
          } catch (error) {
            failure ??= { error };
          }
        }
        if (failure !== undefined) throw failure.error;
      };
      try {
        // A supplied transport is already connected and is NOT closed here: whoever built it owns
        // its socket, which is why the override skips both halves rather than only the dial.
        let transport = input.override;
        if (transport === undefined) {
          // Before the dial, not after: a dial refused for being late is still in flight inside
          // the client library, and closing the transport is what releases whatever it lands as.
          started.push(() => selection.transport.close());
          await selection.connect();
          transport = selection.transport;
        }
        // The bus an app's own code publishes a channel event on (`publishChannelEvent`), in EVERY
        // role: the hub is the `sync` role's, so a job or an action reached none, and an
        // events-only channel — the one kind that needs no replicator — could be fed by nothing
        // but a socket.
        started.push(setChannelTransport(transport));
        // Only a transport that can be disconnected gets a check. `NatsTransport.connected` is a
        // synchronous getter over the client's own state, so no probe is needed; the in-process
        // bus has nothing to lose a connection to, and a check that can only answer `true` is a
        // number in `registered` that means nothing.
        if (saysConnected(transport)) {
          const connectable = transport;
          started.push(
            registerReadinessCheck(
              'transport',
              () => connectable.connected,
              // A publisher serves without the bus, so losing it must not pull the pod from the
              // ingress — it is reported, and `/readyz?deep=1` is where a monitor reads it.
              { onFailure: use === 'publish' ? 'degraded' : 'failing' },
            ),
          );
          // Each time the bus comes (back) up, on one line: the boot line may have said
          // `connecting`, and this is the other half of it.
          started.push(
            connectable.onReconnect(() => {
              logger.info('ultimate bus', { bus: busLabel(connectable), use });
            }),
          );
        }
        return {
          transport,
          // The env key that selected the bus — or the honest answer that no env key did, because
          // a boot line reading `NATS_URL` over a transport the host handed in is a lie a script
          // parses.
          detail: input.override === undefined ? selection.detail : 'runtime override',
          stop,
        };
      } catch (error) {
        // The refusal is the failure worth reporting, not a release on the way out.
        await stop().catch(() => undefined);
        throw error;
      }
    },
  };
}
