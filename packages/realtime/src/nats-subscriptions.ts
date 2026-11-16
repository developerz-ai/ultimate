// Single responsibility: the transport's subscriptions — kept, so a client the library closed for
// good is replaced and every one bound again on the new one; and the reconnect told to listeners
// only once the SERVER holds what was re-sent (a peer's change in that gap was lost). The library's
// own reconnect re-establishes the SAME client's, so a re-bind can never double a delivery.

import type { NatsClient, NatsMessageHandler, NatsSubscription } from './nats-client';

interface Kept {
  readonly subject: string;
  readonly deliver: NatsMessageHandler;
  /** The binding on the current client; `undefined` once that client is gone or the bind failed. */
  live: NatsSubscription | undefined;
}

/** A refused bind, handed back rather than thrown: one bad subject must not strand the others. */
export interface BindFailure {
  readonly subject: string;
  readonly error: unknown;
}

export class NatsSubscriptions {
  readonly #kept = new Set<Kept>();

  /**
   * Binds on `client` first and keeps it only once bound: a subscribe the client refused is the
   * caller's error, and keeping it would re-try a refusal on every re-dial. Returns the release.
   */
  add(
    client: NatsClient,
    subject: string,
    deliver: NatsMessageHandler,
    bind: (call: () => NatsSubscription) => NatsSubscription,
  ): () => void {
    const kept: Kept = { subject, deliver, live: undefined };
    kept.live = bind(() => client.subscribe(subject, deliver));
    this.#kept.add(kept);
    return () => {
      if (!this.#kept.delete(kept)) return;
      const live = kept.live;
      kept.live = undefined;
      live?.unsubscribe();
    };
  }

  /** The client is gone, and every binding with it. Nothing is unsubscribed: there is no wire. */
  orphan(): void {
    for (const kept of this.#kept) kept.live = undefined;
  }

  /** Every kept subscription, bound on a NEW client. Returns the ones it refused. */
  bindAll(client: NatsClient): readonly BindFailure[] {
    const failures: BindFailure[] = [];
    for (const kept of this.#kept) {
      if (kept.live !== undefined) continue;
      try {
        kept.live = client.subscribe(kept.subject, kept.deliver);
      } catch (error) {
        failures.push({ subject: kept.subject, error });
      }
    }
    return failures;
  }
}

/**
 * Answers once the server has read every line this client sent before it — a `SUB` included
 * (`NatsClient.flush`). With no connection there is no server to ask: the client re-sends its SUBs
 * on the way back, and that reconnect is announced in its turn. A flush that fails is that case.
 */
export async function untilServerHolds(client: NatsClient): Promise<void> {
  if (client.connected) await client.flush().catch(() => undefined);
}

/** The listeners, and the one way to tell them: after `untilServerHolds`, each in its own `try`. */
export class NatsReconnectAnnouncer {
  readonly #listeners = new Set<() => void>();
  readonly #fault: (error: unknown) => void;

  /** `fault`: where a listener that throws is reported — it must not stop the others hearing. */
  constructor(fault: (error: unknown) => void) {
    this.#fault = fault;
  }

  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Never rejects: the library calls this from its status loop, the re-dial from its own. */
  async announce(client: NatsClient): Promise<void> {
    await untilServerHolds(client);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#fault(error);
      }
    }
  }
}
