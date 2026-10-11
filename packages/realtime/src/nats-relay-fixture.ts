// A TCP relay in front of a real nats-server, so a live test can break ONE connection without
// touching the server: the container is shared, and stopping it is not a test file's to do. Two
// breaks, because they are two different outages. `cut()` ends every relayed connection the way a
// partition with a reset does. `hold()` is the black hole: every socket stays open and accepting,
// and nothing is forwarded in either direction — the failure only a ping can notice.
// A `-fixture.ts` file is test material and is excluded from the package tarball.

import { parseNatsUrl } from './nats-client';

interface Leg {
  /** The far side of this connection, once it is open. */
  peer: { write(bytes: Uint8Array): number; end(): void } | undefined;
  /** Bytes that arrived before the far side opened. */
  readonly early: Uint8Array[];
}

export interface NatsRelay {
  readonly port: number;
  /** End every relayed connection — both halves, no goodbye. */
  cut(): void;
  /** Go silent: sockets stay open, a new one is accepted, and no byte crosses either way. */
  hold(): void;
  /**
   * Forward again. The connections held meanwhile lost bytes in both directions, so they are
   * ended — what a network does to a flow it dropped packets of — and the next dial is clean.
   */
  release(): void;
  stop(): void;
}

export async function relayTo(
  host: string,
  port: number,
  /** Listen on this port rather than a fresh one: a relay "restarted" where the client dials. */
  listenOn = 0,
): Promise<NatsRelay> {
  const clients = new Set<{ end(): void }>();
  let held = false;
  const listener = Bun.listen<Leg>({
    hostname: '127.0.0.1',
    port: listenOn,
    socket: {
      open(client) {
        client.data = { peer: undefined, early: [] };
        clients.add(client);
        // Accepted and never answered: a black hole completes the TCP handshake too.
        if (held) return;
        // Not awaited: `open` is synchronous, and the server speaks first (INFO) once this lands.
        void Bun.connect<Leg>({
          hostname: host,
          port,
          socket: {
            open(upstream) {
              upstream.data = { peer: client, early: [] };
              client.data.peer = upstream;
              for (const bytes of client.data.early.splice(0)) upstream.write(bytes);
            },
            data(_upstream, bytes) {
              if (!held) client.write(bytes);
            },
            close() {
              client.end();
            },
            error() {
              client.end();
            },
          },
        }).catch(() => client.end());
      },
      data(client, bytes) {
        if (held) return;
        // Copied: the runtime reuses the chunk's buffer once this handler returns.
        if (client.data.peer === undefined) client.data.early.push(Uint8Array.from(bytes));
        else client.data.peer.write(bytes);
      },
      close(client) {
        clients.delete(client);
        client.data.peer?.end();
      },
    },
  });
  const cut = (): void => {
    for (const client of [...clients]) client.end();
  };
  return {
    port: listener.port,
    cut,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      cut();
    },
    stop: () => listener.stop(true),
  };
}

/** `url`, re-pointed at a relay on loopback — credentials kept, since the relay forwards them. */
export function throughRelay(url: string, relayPort: number): string {
  const target = parseNatsUrl(url);
  const credentials =
    target.token !== undefined
      ? `${encodeURIComponent(target.token)}@`
      : target.user !== undefined && target.pass !== undefined
        ? `${encodeURIComponent(target.user)}:${encodeURIComponent(target.pass)}@`
        : '';
  return `nats://${credentials}127.0.0.1:${relayPort}`;
}
