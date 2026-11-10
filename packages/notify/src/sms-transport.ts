// The `smsTransport` port: what an SMS provider adapter implements, the memory reference, and the
// boot's slot. Twilio, Vonage, SNS are the APP's adapters (axiom 8) — this package ships the seam,
// the E.164 check every transport makes, and a transport that never leaves the process.

import { isLocal } from '@ultimat3/core';
import { adapterSlot } from '@ultimat3/core/adapter';
import { NotifySmsNumberInvalidError, NotifySmsTransportMissingError } from './sms-errors';

/** One message, already rendered. The transport never sees catalog keys or a recipient row. */
export interface SmsMessage {
  /** E.164: `+`, a country code, at most 15 digits in all. `assertSmsNumber` is the check. */
  readonly to: string;
  readonly body: string;
  /**
   * The same on every attempt of one delivery. A provider that dedupes reads it; one that does not
   * still answers it back, so a caller can match a retry to its first send.
   */
  readonly idempotencyKey: string;
  /** The delivery's cancellation. Hand it to `fetch`. */
  readonly signal?: AbortSignal | undefined;
}

export interface SmsSendResult {
  /** The transport's own `name`. */
  readonly transport: string;
  /** The provider's message id. Never the number, the body or the idempotency key: it is logged. */
  readonly id: string;
  /** The number accepted — `message.to`. */
  readonly to: string;
  readonly idempotencyKey: string;
}

/** The port. A rejection is a failed delivery; the notifier's job decides whether it retries. */
export interface SmsTransport {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

const E164 = /^\+[1-9]\d{1,14}$/;

/** Whether `value` is an E.164 number — what every transport and `smsChannel` refuse otherwise. */
export const isSmsNumber = (value: string): boolean => E164.test(value);

/** Refuses a non-E.164 number with `X_NOTIFY_SMS_NUMBER_INVALID`. Every transport calls it first. */
export function assertSmsNumber(value: string, recipient?: string): void {
  if (!isSmsNumber(value)) throw new NotifySmsNumberInvalidError({ recipient });
}

export interface MemorySmsTransport extends SmsTransport {
  /** Every accepted message, oldest first — what a test asserts on. */
  readonly sent: readonly SmsMessage[];
  clear(): void;
}

/**
 * The reference transport: keeps messages in the heap and answers a fresh id per send. Never a
 * production default — `smsTransport()` refuses outside development and test instead.
 */
export function memorySmsTransport(name = 'memory'): MemorySmsTransport {
  const sent: SmsMessage[] = [];
  return {
    name,
    sent,
    clear: () => {
      sent.length = 0;
    },
    send(message) {
      assertSmsNumber(message.to);
      sent.push({ to: message.to, body: message.body, idempotencyKey: message.idempotencyKey });
      return Promise.resolve({
        transport: name,
        id: `sms_${crypto.randomUUID()}`,
        to: message.to,
        idempotencyKey: message.idempotencyKey,
      });
    },
  };
}

let localMemory: MemorySmsTransport | undefined;

/** The default: one memory transport per process in development and test, a refusal elsewhere. */
const localTransport = (): SmsTransport => ({
  name: 'memory',
  send(message) {
    if (!isLocal()) return Promise.reject(new NotifySmsTransportMissingError());
    localMemory ??= memorySmsTransport();
    return localMemory.send(message);
  },
});

const slot = adapterSlot<SmsTransport>(localTransport);

/**
 * The boot's installer, on `@ultimat3/notify/adapter` only: an app names `smsTransport:` in
 * `apps/<app>/runtime.ts`. Its release removes THIS install, in any order (`adapterSlot`).
 */
export function installSmsTransport(transport: SmsTransport): () => void {
  return slot.install(transport);
}

/** Back to the default, for a test that installed one and must hand the process back. */
export function resetSmsTransport(): void {
  slot.reset();
  localMemory = undefined;
}

/** The installed transport, read per send — a channel is declared long before a boot installs. */
export const smsTransport = (): SmsTransport => slot.current();
