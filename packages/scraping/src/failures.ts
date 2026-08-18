// Reading a thrown value safely. Every classification decision this package makes — is this
// terminal, does this burn the session, what code does the event line carry — asks these two
// questions, and both have to be answerable about a value nobody here constructed.

import { isUltimateError } from '@ultimat3/core';

/** The stable code, or `undefined`. Never the message: a message is whatever a site put in it. */
export function errorCode(thrown: unknown): string | undefined {
  if (isUltimateError(thrown)) return thrown.code;
  // A structural read, not `instanceof`: an error crossing a worker or a subprocess arrives as a
  // plain object, and refusing to recognise it there is how a terminal failure gets retried.
  if (typeof thrown === 'object' && thrown !== null) {
    const code: unknown = (thrown as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('X_')) return code;
  }
  return undefined;
}

/**
 * Codes after which the persisted identity must not be reused. `X_SCRAPE_BLOCKED` is the whole
 * reason this list exists: a flagged profile stays flagged, so the retry has to arrive as
 * somebody else or it fails identically, forever.
 */
export const BURNS_SESSION: ReadonlySet<string> = new Set([
  'X_SCRAPE_BLOCKED',
  'X_SCRAPE_SESSION_EXPIRED',
]);

/**
 * Codes no retry may ever follow, whatever the retry policy says. `X_SCRAPE_AUTH_FAILED` is the
 * one that matters: a site that locks an account after three wrong attempts turns a retrying
 * framework into the thing that destroys the user's account.
 */
export const NEVER_RETRIED: ReadonlySet<string> = new Set([
  'X_SCRAPE_AUTH_FAILED',
  'X_SCRAPE_PROMPT_UNANSWERED',
]);

export const burnsSession = (thrown: unknown): boolean => {
  const code = errorCode(thrown);
  return code !== undefined && BURNS_SESSION.has(code);
};

export const neverRetried = (thrown: unknown): boolean => {
  const code = errorCode(thrown);
  return code !== undefined && NEVER_RETRIED.has(code);
};
