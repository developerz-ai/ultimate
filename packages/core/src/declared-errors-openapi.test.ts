// The declared refusals in an operation's `responses`: today's bytes when none are declared, an
// enum of `type`s on a status only the list answers, an open Problem kept where the framework
// already answers that status.

import { describe, expect, test } from 'bun:test';
import { withDeclaredResponses } from './declared-errors-openapi';

const STATUS: Readonly<Record<string, number>> = {
  X_POST_NOT_FOUND: 404,
  X_POST_GONE: 404,
  X_SLUG_TAKEN: 409,
};
const wire = {
  statusOf: (code: string) => STATUS[code],
  typeFor: (code: string) => `urn:ultimate:error:${code}`,
  problemRef: '#/components/schemas/Problem',
};
const base = {
  '200': { description: 'ok' },
  '409': { description: 'X_IDEMPOTENCY_CONFLICT', content: { open: true } },
};

describe('withDeclaredResponses', () => {
  test('absent or empty: the same members, nothing added', () => {
    expect(withDeclaredResponses(base, undefined, wire)).toEqual(base);
    expect(withDeclaredResponses(base, [], wire)).toEqual(base);
  });

  test('a status only the list answers narrows type to its sorted codes', () => {
    const responses = withDeclaredResponses(base, ['X_POST_NOT_FOUND', 'X_POST_GONE'], wire);
    expect(responses['404']).toEqual({
      description: 'X_POST_GONE | X_POST_NOT_FOUND',
      content: {
        'application/problem+json': {
          schema: {
            allOf: [
              { $ref: '#/components/schemas/Problem' },
              {
                properties: {
                  type: {
                    enum: ['urn:ultimate:error:X_POST_GONE', 'urn:ultimate:error:X_POST_NOT_FOUND'],
                  },
                },
              },
            ],
          },
        },
      },
      'x-ultimate-errors': ['X_POST_GONE', 'X_POST_NOT_FOUND'],
    });
  });

  test('a status the framework answers keeps its schema and names the declared code', () => {
    const responses = withDeclaredResponses(base, ['X_SLUG_TAKEN'], wire);
    expect(responses['409']).toEqual({
      description: 'X_IDEMPOTENCY_CONFLICT | X_SLUG_TAKEN',
      content: { open: true },
      'x-ultimate-errors': ['X_SLUG_TAKEN'],
    });
    expect(responses['200']).toBe(base['200']);
  });
});
