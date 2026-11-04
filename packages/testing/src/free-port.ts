// One responsibility: a port the e2e app can listen on AND a browser will open. The OS hands out
// whatever is free in its ephemeral range, and a box whose range starts at 1024 hands out ports
// Chrome refuses outright — every navigation of the run then fails `net::ERR_UNSAFE_PORT`.

/** What `freePort` needs of a listener: the port the OS gave it, and a way to give it back. */
export interface PortProbe {
  readonly port: number;
  stop(): void;
}

/**
 * Chromium's restricted ports (`net/base/port_util.cc`, `kRestrictedPorts`) from 1024 up — the
 * ones an unprivileged listener can be handed. Below 1024 the OS never answers a `port: 0` ask.
 */
export const BROWSER_REFUSED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10_080,
]);

/** Listen on a port of the OS's choosing. */
const listenOnAnyPort = (): PortProbe => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  return { port: probe.port ?? 0, stop: () => void probe.stop(true) };
};

/**
 * A port nothing holds right now, asked of the OS and handed to the child — and one a browser will
 * open. A refused port is KEPT listening while the next is asked for, so the OS cannot answer with
 * it again: the walk ends after at most one ask per refused port, with no counter and no retry.
 */
export const freePort = (listen: () => PortProbe = listenOnAnyPort): number =>
  freePortApartFrom([], listen);

/**
 * The same, and none of `taken` — the ports this caller already handed out and RELEASED, which the
 * OS is free to answer with again. Two bare `freePort()` calls for one app gave its web role and
 * its scrape listener the same number (CI, 2026-10-14). Both bound it — `localhost` names `::1` and
 * `127.0.0.1` there — and the browser's requests reached `/metrics`'s `not found` instead of the
 * app. Held like a refused port, so the walk still ends.
 */
export const freePortApartFrom = (
  taken: readonly number[],
  listen: () => PortProbe = listenOnAnyPort,
): number => {
  const held: PortProbe[] = [];
  try {
    for (;;) {
      const probe = listen();
      if (BROWSER_REFUSED_PORTS.has(probe.port) || taken.includes(probe.port)) {
        held.push(probe);
        continue;
      }
      probe.stop();
      return probe.port;
    }
  } finally {
    for (const probe of held) probe.stop();
  }
};

/**
 * The addresses `localhost` can name. A dual-stack host (GitHub's Ubuntu runner, a Debian container)
 * maps it to both, and Bun binds the FIRST it resolves: a holder on `::1` left `localhost` free on
 * `127.0.0.1`, so a probe on `localhost`, or on Bun's default `::`, answered "free" for a port
 * `x dev` then met held (scaffold-smoke, CI run 41764752262). Each is asked on its own.
 */
export const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1'];

/** An address this host does not have — IPv6 switched off — holds nothing. */
const ABSENT = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL']);

/** Whether `port` is free on every loopback address `localhost` may resolve to. */
export const loopbackFree = (
  port: number,
  addresses: readonly string[] = LOOPBACK_ADDRESSES,
): boolean =>
  addresses.every((hostname) => {
    try {
      Bun.listen({ hostname, port, socket: { data: () => undefined } }).stop(true);
      return true;
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : '';
      return typeof code === 'string' && ABSENT.has(code);
    }
  });

/**
 * A free port whose NEIGHBOUR is free too, both ones a browser opens. `x dev` binds the web role on
 * `port` and the sync node on `port + 1`, so a lone free port whose neighbour another process held
 * was an e2e app that listened, failed its sync bind and exited before `/readyz` — the CLI's own
 * `freeDevPort` rule (`dev-supervisor.ts`), which this package cannot import. A candidate is held
 * while the next is asked for, as a refused port is, so the walk ends. The candidate itself is held
 * on Bun's dual-stack `::`, which covers both loopbacks; the neighbour is asked of each.
 */
export const freePortPair = (
  listen: () => PortProbe = listenOnAnyPort,
  canBind: (port: number) => boolean = loopbackFree,
): number => {
  const held: PortProbe[] = [];
  try {
    for (;;) {
      const probe = listen();
      const next = probe.port + 1;
      if (
        BROWSER_REFUSED_PORTS.has(probe.port) ||
        BROWSER_REFUSED_PORTS.has(next) ||
        !canBind(next)
      ) {
        held.push(probe);
        continue;
      }
      probe.stop();
      return probe.port;
    }
  } finally {
    for (const probe of held) probe.stop();
  }
};
