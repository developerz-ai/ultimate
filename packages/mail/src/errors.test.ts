// The retry classification of a refused send, asserted against the QUEUE's own decision function
// rather than against this package's table: `sendMailJob` gives every failure five attempts, and
// only a registered code plus the per-instance override stop a rejected credential from being
// offered four more times.

import { describe, expect, test } from 'bun:test';
import { declaredErrorRetry, describeErrorCode, ERROR_DOCS_URL } from '@ultimat3/core';
import { nextRetryForError } from '@ultimat3/jobs';
import {
  localeMissing,
  MAIL_ERROR_CODES,
  MAIL_ERROR_RETRY,
  type SendFailure,
  sendFailed,
} from './errors';

const failure = (patch: Partial<SendFailure> = {}): SendFailure => ({
  driver: 'smtp',
  stage: 'data',
  detail: 'the server refused the message',
  retryable: false,
  fix: 'x doctor --json',
  ...patch,
});

// `sendMailJob`'s own policy, copied so the assertions below are about the run an app really gets.
const POLICY = { attempts: 5, backoff: 'exponential' } as const;

describe('unit · X_MAIL_SEND_FAILED is classified, not merely described', () => {
  test('the code is REGISTERED — a table entry is not something classifyThrown can read', () => {
    expect(declaredErrorRetry('X_MAIL_SEND_FAILED')).toBe(MAIL_ERROR_RETRY.X_MAIL_SEND_FAILED);
  });

  test('a permanent refusal is terminal ON THE ERROR, not only in meta', () => {
    const error = sendFailed(failure({ status: 550, retryable: false }));
    expect(error.retry).toBe('terminal');
    expect(error.meta?.['retryable']).toBe(false);
  });

  test('a transient refusal is retryable', () => {
    expect(sendFailed(failure({ status: 421, retryable: true })).retry).toBe('retryable');
  });

  test('a 550 hard bounce dead-letters at attempt 1 — no four more identical sends', () => {
    const decision = nextRetryForError(POLICY, 1, sendFailed(failure({ status: 550 })));
    expect(decision.retry).toBe(false);
    expect(decision.stoppedBy).toBe('terminal');
  });

  test('a rejected credential dead-letters at attempt 1 too', () => {
    const decision = nextRetryForError(
      POLICY,
      1,
      sendFailed(failure({ stage: 'auth', status: 535 })),
    );
    expect(decision.retry).toBe(false);
    expect(decision.stoppedBy).toBe('terminal');
  });

  test('a greylist keeps every attempt the policy declares', () => {
    const decision = nextRetryForError(
      POLICY,
      1,
      sendFailed(failure({ stage: 'data', status: 421, retryable: true })),
    );
    expect(decision.retry).toBe(true);
    expect(decision.stoppedBy).toBeUndefined();
  });

  test('an unanswered socket is retryable — a failure with no status is not a permanent one', () => {
    const error = sendFailed(failure({ stage: 'connect', retryable: true }));
    expect(error.retry).toBe('retryable');
    expect(nextRetryForError(POLICY, 1, error).retry).toBe(true);
  });
});

/**
 * `MailError` passes no `docs:`, so the link is whatever the registry resolved: one page for every
 * code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal — a
 * hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every suite in
 * the tree, with the code interpolated into a fragment no page has ever had an anchor for.
 *
 * The INSTANCE is asserted first, and that ordering is the finding. `jobs` and `realtime` both had
 * `describeErrorCode(code).docs === ERROR_DOCS_URL` and both were green for as long as their
 * constructors were overriding `docs:` with the dead URL on the way out — a registry read cannot
 * see what a constructor puts on an instance.
 */
describe('unit · where a mail error sends its reader', () => {
  test('a CONSTRUCTED error carries the one page, never a per-code URL', () => {
    const errors = [localeMissing('welcome'), sendFailed(failure())];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
      expect(error.docs).not.toContain('ultimate.dev');
    }
  });

  test('and every code mail declares resolves to that same link', () => {
    for (const code of MAIL_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });
});
