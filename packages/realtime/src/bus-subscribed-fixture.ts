// `subscribed()`: a live test's proof that the bus HOLDS a subscription before it publishes — a
// probe from the publisher's own connection, heard by the subscriber (`3f6d1b24d`, #1132).
// `scripts/bus-subscribed.ts` refuses a live-test publish this does not precede.
//
// A `-fixture.ts` file is test material and is excluded from the package tarball.

import { isUltimateError } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import type { Transport, TransportHandler, TransportSubscription } from './fanout';

/** Marks a probe's payload, so the subscriber's handler never sees one. */
const PROBE = '\u0000x-subscribed:';
/** The token a wildcard is probed with: matched by `*` and by `>`. */
const PROBE_TOKEN = 'x-probe';
/** Probes before the subscription is called never held: 400 × 25 ms, ten seconds of server time. */
const DEFAULT_POLLS = 400;

export interface SubscribedOptions {
  /** The connection that subscribes. */
  readonly subscriber: Transport;
  /** The connection the test publishes from — the one whose publish must not beat the SUB. */
  readonly publisher: Transport;
  readonly subject: string;
  readonly handler: TransportHandler;
  /** Probes before refusing. */
  readonly polls?: number | undefined;
  /** Between two probes; a unit test passes one that returns at once. */
  readonly pause?: (() => Promise<void>) | undefined;
}

/** The subscription, and the way to prove it again once its connection came back. */
export interface ConfirmedSubscription extends TransportSubscription {
  /** Resolves once a fresh probe was heard — call it after a reconnect, before the next publish. */
  subscribed(): Promise<void>;
}

/** A subject the pattern matches: each `*` and a trailing `>` become one concrete token. */
export function probeSubjectFor(pattern: string): string {
  return pattern
    .split('.')
    .map((token) => (token === '*' || token === '>' ? PROBE_TOKEN : token))
    .join('.');
}

// real-clock: the server reads the SUB on its own time; a probe lost before then is re-sent.
const serverPace = (): Promise<void> => Bun.sleep(25);

/** Subscribe, then resolve once a probe published from `publisher` was heard through it. */
export async function subscribed(options: SubscribedOptions): Promise<ConfirmedSubscription> {
  const heard = new Set<string>();
  const subscription = await options.subscriber.subscribe(options.subject, (payload, subject) => {
    if (payload.startsWith(PROBE)) heard.add(payload);
    else options.handler(payload, subject);
  });
  const polls = options.polls ?? DEFAULT_POLLS;
  const pause = options.pause ?? serverPace;
  const probeSubject = probeSubjectFor(options.subject);
  const confirm = async (): Promise<void> => {
    const probe = `${PROBE}${crypto.randomUUID()}`;
    for (let poll = 0; poll < polls; poll += 1) {
      // A publisher whose connection is still coming back refuses, coded: an unheard probe, not
      // the verdict — the next poll asks again. Anything else is the test's failure, as thrown.
      await options.publisher.publish(probeSubject, probe).catch((error: unknown) => {
        if (!isUltimateError(error) || error.code !== 'X_TRANSPORT_UNAVAILABLE') throw error;
      });
      // Two looks: a bus that delivers on its own time gets one pause to do it in.
      if (heard.has(probe)) return;
      await pause();
      if (heard.has(probe)) return;
    }
    throw new TransportUnavailableError({
      transport: options.subscriber.name,
      reason: `the subscription to ${options.subject} was never heard: ${polls} probes on ${probeSubject} went unanswered`,
      fix: `bun test ./packages/realtime/src/bus-subscribed-fixture.test.ts   # then check the bus the test dials (TEST_NATS_URL) is up`,
    });
  };
  try {
    await confirm();
  } catch (error) {
    subscription.unsubscribe();
    throw error;
  }
  return {
    subject: subscription.subject,
    unsubscribe: () => subscription.unsubscribe(),
    subscribed: confirm,
  };
}
