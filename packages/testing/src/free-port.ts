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
export const freePort = (listen: () => PortProbe = listenOnAnyPort): number => {
  const refused: PortProbe[] = [];
  try {
    for (;;) {
      const probe = listen();
      if (BROWSER_REFUSED_PORTS.has(probe.port)) {
        refused.push(probe);
        continue;
      }
      probe.stop();
      return probe.port;
    }
  } finally {
    for (const probe of refused) probe.stop();
  }
};
