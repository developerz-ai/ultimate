// Single responsibility: the readiness CHECK — its signature and its two answers. The mode that
// decides what a failing one does to `/readyz` is `config-health.ts`'s.

export type ReadinessStatus = 'ok' | 'failing';

/**
 * Synchronous, and that is the design, not a limitation. **Do not widen this to
 * `() => Promise<boolean>`** — the signature is the mechanism.
 *
 * A readiness endpoint that does I/O is a liveness bomb. A probe that awaits a network call takes
 * as long as the dependency does, so a slow database makes the endpoint miss its `timeoutSeconds`,
 * the kubelet reads that as unready, and capacity is pulled from an already-struggling system —
 * the outage the probe existed to prevent, caused by the probe. Worse under a liveness probe
 * sharing the handler: the pod is killed and restarts into the same slow database, cold.
 *
 * So the owner of the dependency keeps a boolean fresh — a pool exposes `isOpen`, a background
 * poller flips a flag on its own schedule with its own timeout — and this reads it. That puts the
 * waiting where a timeout can be tuned, and leaves this path unable to block. A check that throws
 * is `failing`.
 */
export type ReadinessCheck = () => boolean;
