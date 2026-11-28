// Single responsibility: the recipient door of `issueVerification` — a `to` is honoured only on a
// purpose declared `recipient: 'explicit'`, and refused (before any write) on every other, so a
// reset or sign-in link cannot be redirected by a caller's input.

import { describe, expect, test } from 'bun:test';
import { assert, frozenClock } from '@ultimat3/core';
import type { AuthVerification } from './adapter';
import { AuthError } from './errors';
import { memoryAuthAdapter } from './memory-adapter';
import {
  defineVerificationPurpose,
  issueVerification,
  type MailSender,
  type VerificationRuntime,
} from './verify';

interface Sent {
  readonly template: string;
  readonly to: string;
}

/** The real memory adapter with a write log: a refused call must leave `written` empty. */
const runtime = (): VerificationRuntime & { sent: Sent[]; written: AuthVerification[] } => {
  const adapter = memoryAuthAdapter();
  const sent: Sent[] = [];
  const written: AuthVerification[] = [];
  const mail: MailSender = {
    send: async (template, to) => {
      sent.push({ template, to });
    },
  };
  return {
    clock: frozenClock(0),
    mail,
    sent,
    written,
    store: {
      putVerification: async (record) => {
        written.push(record);
        await adapter.putVerification(record);
      },
      takeVerification: (purpose, identifier, hash) =>
        adapter.takeVerification(purpose, identifier, hash),
    },
  };
};

const caught = async (fn: () => Promise<unknown>): Promise<AuthError> => {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown !== undefined && !(thrown instanceof AuthError)) throw thrown;
  assert(
    thrown instanceof AuthError,
    'the call under test resolved instead of rejecting with an AuthError',
    'assert on the resolved value directly instead of wrapping the call in caught()',
  );
  return thrown;
};

describe('the recipient is not the store key', () => {
  // Declared once, at module scope like an app would. Only a purpose that says so takes a `to`.
  // A name of its own per load: a rerun in the same process (flake-hunt) evaluates this file
  // again, and a second declaration of one name is refused.
  const keyed = defineVerificationPurpose({
    name: `test-keyed-invite-${crypto.randomUUID()}`,
    template: 'auth.test-keyed-invite',
    ttlMs: 60_000,
    identifier: (raw) => raw.toLowerCase(),
    recipient: 'explicit',
  });

  test('mail goes to `to`, the row is keyed by the identifier, `to` is not normalised', async () => {
    const rt = runtime();
    const { token } = await keyed.issue(rt, {
      identifier: 'Org-1|Ada@Example.test',
      to: 'Ada@Example.test',
      locale: 'en',
    });
    expect(rt.sent[0]?.to).toBe('Ada@Example.test');
    expect(rt.written.find((r) => r.identifier === 'org-1|ada@example.test')).toBeDefined();
    const row = await keyed.consume(rt, { identifier: 'Org-1|Ada@Example.test', token });
    expect(row.identifier).toBe('org-1|ada@example.test');
  });

  test('a blank or absent `to` on such a purpose is refused before any write or mail', async () => {
    const rt = runtime();
    for (const to of ['', '   ', undefined]) {
      const error = await caught(() => keyed.issue(rt, { identifier: 'k', to, locale: 'en' }));
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.meta?.['option']).toBe('verification.to');
    }
    expect(rt.written).toHaveLength(0);
    expect(rt.sent).toHaveLength(0);
  });

  test('a `to` on a purpose that did not declare it is refused: reset and sign-in links go to the keyed inbox', async () => {
    const rt = runtime();
    for (const purpose of ['password-reset', 'email-verify']) {
      const error = await caught(() =>
        issueVerification(rt, {
          purpose,
          identifier: 'ada@example.com',
          to: 'attacker@evil.test',
          locale: 'en',
        }),
      );
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.meta?.['option']).toBe('verification.to');
    }
    expect(rt.written).toHaveLength(0);
    expect(rt.sent).toHaveLength(0);
  });
});
