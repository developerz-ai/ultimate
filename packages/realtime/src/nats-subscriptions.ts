// Single responsibility: the transport's kept list of live subscriptions, so a client the library
// closed for good can be replaced and every subscription bound again on the new one. The library's
// own reconnect never reaches this list — it re-establishes the SAME client's subscriptions — so a
// subscription is bound once per client and a re-bind can never double a delivery.

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
