// The refusal responses every projected document states the same way: one `application/problem+json`
// envelope, and the rate-limit headers a 429 or a limited 200 carries. One copy, so the cookie
// document, a bearer mount's and its tenant listing can never drift apart.

import { PROBLEM_SCHEMA_NAME, schemaRef } from './naming';

export const RATE_LIMIT_HEADERS: Record<string, unknown> = {
  'RateLimit-Limit': {
    description: 'Requests the bucket admits per window.',
    schema: { type: 'integer' },
  },
  'RateLimit-Remaining': {
    description: 'Requests left in the current window.',
    schema: { type: 'integer' },
  },
  'RateLimit-Reset': {
    description: 'Seconds until the bucket is full again.',
    schema: { type: 'integer' },
  },
};

export const RETRY_AFTER_HEADER: Record<string, unknown> = {
  'Retry-After': {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', minimum: 1 },
  },
};

/** A refusal response: its description, any headers, and the shared Problem schema. */
export function problem(
  description: string,
  headers?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description,
    ...(headers === undefined ? {} : { headers }),
    content: { 'application/problem+json': { schema: { $ref: schemaRef(PROBLEM_SCHEMA_NAME) } } },
  };
}

/** The codes a 429 can carry here, named so a client knows which refusal it is reading. */
export function tooManyDescription(throttled: boolean, metered: boolean): string {
  const codes = [
    ...(throttled ? ['X_RATE_LIMITED'] : []),
    ...(metered ? ['X_METER_EXCEEDED'] : []),
  ].join(' or ');
  return `${codes} — retry after Retry-After seconds`;
}
