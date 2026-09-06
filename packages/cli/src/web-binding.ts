// How a process binds its sockets, and what it admits about itself. A LEAF: it imports nothing,
// so every role can read it without pulling `dev-roles` — which is what made this its own file.
// `dev-sync` needs the default and `dev-roles` already imports `dev-sync`, so reading it from
// there would be a runtime import cycle in the framework's own boot path.

export interface WebBinding {
  readonly dev: boolean;
  /**
   * The interface every socket this process opens binds to — the web role, the metrics endpoint
   * and the `sync` node alike. ONE value, because they are one decision: a process that serves
   * its app on loopback and its live-query patch stream on `0.0.0.0` has not bound to loopback,
   * it has just moved which port the exposure is on.
   */
  readonly hostname: string;
}

/**
 * Loopback and dev-mode. What `x dev` means, and what a container must override — a process bound
 * to `localhost` inside a container is unreachable from the port mapping, the load balancer and
 * every PaaS health probe, which is the same failure in four costumes.
 */
export const DEV_BINDING: WebBinding = { dev: true, hostname: 'localhost' };
