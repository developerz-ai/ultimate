// The preference gate: one question, asked once per (recipient, notifier, channel), after the wait.
//
// `noticed` has no gate at all — it leaves opt-out to a `config.if` closure the app writes per
// channel, which is four teams writing the same closure four times. So the GATE ships here. What
// does NOT ship, and never will, is what it consults: the notification taxonomy is the app's, and
// so is `quietHours` — "quiet" is 22:00–07:00 in the recipient's zone for one product, working
// hours only for the next, and a framework that picked one would be shipping a business
// convention (axiom 8).
//
// Which is why this file declares an interface and two trivial implementations and nothing else.

import type { Ctx } from '@ultimat3/core';
import type { NotifyEvent, Recipient } from './notification';

export interface PreferenceQuery<Params = unknown> {
  readonly recipient: Recipient;
  /** The notifier's name — the app's taxonomy key, whatever its taxonomy is. */
  readonly notifier: string;
  readonly channel: string;
  readonly event: NotifyEvent<Params>;
  /** The run's context: `ctx.now()` is the clock a quiet-hours rule must read, never `Date.now()`. */
  readonly ctx: Ctx;
}

export interface PreferenceStore {
  /**
   * `false` suppresses THIS channel and nothing else — the other channels of the same notifier
   * still fire. That is the whole point of asking per channel: "email me weekly, ping me in-app
   * immediately" is one recipient's normal answer, and a gate that returned one boolean for the
   * notification could not express it.
   */
  allows(query: PreferenceQuery): Promise<boolean> | boolean;
}

/**
 * The default, and it is `true`. An app that installs nothing gets `noticed`'s behaviour, which is
 * the right default for a framework: silence-by-default would mean a notifier that delivers
 * nothing until an app writes a store, and the first symptom would be a missing email.
 */
export const allowAllPreferences = (): PreferenceStore => ({ allows: () => true });

export interface MemoryPreferenceStore extends PreferenceStore {
  /** Opt `recipient` out of `channel` for `notifier`. `'*'` as the notifier is every notifier. */
  deny(input: { recipient: string; notifier: string; channel: string }): void;
  clear(): void;
}

const optOutKey = (recipient: string, notifier: string, channel: string): string =>
  JSON.stringify([recipient, notifier, channel]);

/**
 * A test double and a dev store, not a product. Real preferences live in the app's own table
 * beside the taxonomy that names them; this exists so the gate can be exercised without one.
 */
export function createMemoryPreferenceStore(): MemoryPreferenceStore {
  const denied = new Set<string>();
  return {
    allows(query) {
      const id = query.recipient.id;
      return (
        !denied.has(optOutKey(id, query.notifier, query.channel)) &&
        !denied.has(optOutKey(id, '*', query.channel))
      );
    },
    deny(input) {
      denied.add(optOutKey(input.recipient, input.notifier, input.channel));
    },
    clear() {
      denied.clear();
    },
  };
}
