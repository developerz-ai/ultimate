// Direct coverage for email-verification / password-reset — the flow where a mailed link is a
// credential. Untested until now despite `session.ts`-adjacent risk (single-use, expiring,
// constant-time compared).

import { describe, expect, test } from 'bun:test';
import { assert, type FrozenClock, frozenClock } from '@ultimat3/core';
import type { AuthVerification, VerificationStore } from './adapter';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import { sha256Hex } from './tokens';
import {
  consumeVerification,
  DEFAULT_VERIFICATION_TTL_MS,
  issueVerification,
  type MailSender,
  VERIFICATION_TEMPLATES,
  type VerificationRuntime,
} from './verify';

/**
 * A write log over the real `MemoryAdapter`, never a second store: both methods delegate, so these
 * cases run the same verification lifecycle every other suite in this package does and a drift in
 * the adapter fails here too. `written` exists only because `putVerification` is the one call whose
 * *argument* a test needs to read — proving the token is stored hashed.
 */
class RecordingVerificationStore implements VerificationStore {
  readonly written = new Map<string, AuthVerification>();
  readonly #adapter = new MemoryAdapter();

  async putVerification(record: AuthVerification): Promise<void> {
    await this.#adapter.putVerification(record);
    this.written.set(`${record.purpose}:${record.identifier}`, record);
  }

  async takeVerification(
    purpose: string,
    identifier: string,
    tokenHash: string,
  ): Promise<AuthVerification | null> {
    return this.#adapter.takeVerification(purpose, identifier, tokenHash);
  }
}

/** A third-party adapter that ignores the hash argument — the case the seam cannot enforce. */
class SloppyVerificationStore implements VerificationStore {
  readonly #rows = new Map<string, AuthVerification>();

  async putVerification(record: AuthVerification): Promise<void> {
    this.#rows.set(`${record.purpose}:${record.identifier}`, record);
  }

  async takeVerification(purpose: string, identifier: string): Promise<AuthVerification | null> {
    return this.#rows.get(`${purpose}:${identifier}`) ?? null;
  }
}

class RecordingMail implements MailSender {
  readonly sent: Array<{
    template: string;
    to: string;
    data: Readonly<Record<string, unknown>>;
    locale: string;
  }> = [];

  async send(
    template: string,
    to: string,
    data: Readonly<Record<string, unknown>>,
    locale: string,
  ): Promise<void> {
    this.sent.push({ template, to, data, locale });
  }
}

interface TestRuntime extends VerificationRuntime {
  readonly store: RecordingVerificationStore;
  readonly clock: FrozenClock;
  readonly mail: RecordingMail;
}

const runtime = (startMs = 0): TestRuntime => ({
  store: new RecordingVerificationStore(),
  clock: frozenClock(startMs),
  mail: new RecordingMail(),
});

const caught = async (fn: () => Promise<unknown>): Promise<AuthError> => {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  // An unexpected throw keeps its own stack; only "it resolved" and "it threw something else"
  // become X_INVARIANT, so a green run can never mean the call quietly succeeded.
  if (thrown !== undefined && !(thrown instanceof AuthError)) throw thrown;
  assert(
    thrown instanceof AuthError,
    'the call under test resolved instead of rejecting with an AuthError',
    'assert on the resolved value directly instead of wrapping the call in caught()',
  );
  return thrown;
};

describe('issueVerification', () => {
  test('stores the token hashed, never in the clear', async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });

    const row = rt.store.written.get('email-verify:a@example.com');
    expect(row).toBeDefined();
    expect(row?.tokenHash).toBe(sha256Hex(token));
    expect(row?.tokenHash).not.toBe(token);
  });

  test('mails the correct template and includes the raw token as the link by default', async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'password-reset',
      identifier: 'a@example.com',
      locale: 'fr',
    });

    expect(rt.mail.sent).toHaveLength(1);
    const [message] = rt.mail.sent;
    expect(message?.template).toBe(VERIFICATION_TEMPLATES['password-reset']);
    expect(message?.to).toBe('a@example.com');
    expect(message?.locale).toBe('fr');
    // `MailSender.send`'s `data` is `Record<string, unknown>` by design — an app's own template
    // variables ride in it — so `link` genuinely comes from the index signature.
    expect(message?.data['link']).toBe(token);
  });

  test('runs the token through a link builder when given one', async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
      link: (t) => `https://app.example.com/verify?token=${t}`,
    });

    expect(rt.mail.sent[0]?.data['link']).toBe(`https://app.example.com/verify?token=${token}`);
  });

  test('defaults ttl per purpose, and honors an override', async () => {
    const rt = runtime(1_000);
    const issued = await issueVerification(rt, {
      purpose: 'password-reset',
      identifier: 'a@example.com',
      locale: 'en',
    });
    expect(issued.expiresAt.getTime()).toBe(1_000 + DEFAULT_VERIFICATION_TTL_MS['password-reset']);

    const overridden = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'b@example.com',
      locale: 'en',
      ttlMs: 5_000,
    });
    expect(overridden.expiresAt.getTime()).toBe(1_000 + 5_000);
  });

  test('a second issue for the same purpose+identifier overwrites the first (one live token)', async () => {
    const rt = runtime();
    const first = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });
    const second = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });

    expect(second.token).not.toBe(first.token);
    const error = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'a@example.com',
        token: first.token,
      }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });
});

describe('consumeVerification', () => {
  test('succeeds once with the matching token', async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });

    const record = await consumeVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      token,
    });
    expect(record.identifier).toBe('a@example.com');
  });

  test('rejects a second redemption of the same token', async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });
    await consumeVerification(rt, { purpose: 'email-verify', identifier: 'a@example.com', token });

    const error = await caught(() =>
      consumeVerification(rt, { purpose: 'email-verify', identifier: 'a@example.com', token }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('rejects an unknown identifier', async () => {
    const rt = runtime();
    const error = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'nobody@example.com',
        token: 'whatever',
      }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('rejects the wrong token for a real, live record', async () => {
    const rt = runtime();
    await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });

    const error = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'a@example.com',
        token: 'not-the-real-token',
      }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test("a wrong guess leaves the victim's live token redeemable", async () => {
    const rt = runtime();
    const { token } = await issueVerification(rt, {
      purpose: 'password-reset',
      identifier: 'victim@example.com',
      locale: 'en',
    });

    // The attack: an unauthenticated POST naming a known address, with any token at all. Repeated,
    // because one guess per second is what makes it a permanent denial of the reset link.
    for (const guess of ['x', 'y', 'z']) {
      const error = await caught(() =>
        consumeVerification(rt, {
          purpose: 'password-reset',
          identifier: 'victim@example.com',
          token: guess,
        }),
      );
      expect(error.code).toBe('X_UNAUTHENTICATED');
    }

    const record = await consumeVerification(rt, {
      purpose: 'password-reset',
      identifier: 'victim@example.com',
      token,
    });
    expect(record.identifier).toBe('victim@example.com');
  });

  test('refuses a wrong token even when the store hands back an unmatched row', async () => {
    const rt: VerificationRuntime = {
      store: new SloppyVerificationStore(),
      clock: frozenClock(0),
      mail: new RecordingMail(),
    };
    await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'a@example.com',
      locale: 'en',
    });

    const error = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'a@example.com',
        token: 'not-the-real-token',
      }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('rejects an expired token even when it matches', async () => {
    const rt = runtime(0);
    const { token } = await issueVerification(rt, {
      purpose: 'password-reset',
      identifier: 'a@example.com',
      locale: 'en',
    });
    rt.clock.advance(DEFAULT_VERIFICATION_TTL_MS['password-reset']);

    const error = await caught(() =>
      consumeVerification(rt, { purpose: 'password-reset', identifier: 'a@example.com', token }),
    );
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('the error never distinguishes "unknown" from "wrong token" from "expired"', async () => {
    const rt = runtime();
    const unknown = await caught(() =>
      consumeVerification(rt, { purpose: 'email-verify', identifier: 'x@example.com', token: 't' }),
    );

    await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'y@example.com',
      locale: 'en',
    });
    const wrong = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'y@example.com',
        token: 'nope',
      }),
    );

    // The third outcome the test's name promises: a token that is real, matching, and simply too
    // late. It is the one an attacker can produce on purpose, so it must read like the other two.
    const { token: stale } = await issueVerification(rt, {
      purpose: 'email-verify',
      identifier: 'z@example.com',
      locale: 'en',
    });
    rt.clock.advance(DEFAULT_VERIFICATION_TTL_MS['email-verify'] + 1);
    const expired = await caught(() =>
      consumeVerification(rt, {
        purpose: 'email-verify',
        identifier: 'z@example.com',
        token: stale,
      }),
    );

    expect(unknown.code).toBe(wrong.code);
    expect(unknown.fix).toBe(wrong.fix);
    expect(expired.code).toBe(unknown.code);
    expect(expired.fix).toBe(unknown.fix);
    expect(expired.cause).toBe(unknown.cause);
  });
});
