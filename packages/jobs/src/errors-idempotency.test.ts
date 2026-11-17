// `X_IDEMPOTENCY_REQUIRED` names the declaration that lacks the key — the file and line `job()` was
// called from, never only the positional counter or an unrelated example name — and its fix is the
// one missing field, keyed by a name read off that file.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { declarationSite, IdempotencyRequiredError } from './errors-idempotency';
import { job } from './job';

const declareUnkeyed = (): UltimateError => {
  try {
    job({
      tenant: 'none',
      input: t.object({}),
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    } as unknown as Parameters<typeof job>[0]);
  } catch (error) {
    return error as UltimateError;
  }
  return expect.unreachable('job() accepted a definition with no idempotencyKey');
};

describe('unit · X_IDEMPOTENCY_REQUIRED', () => {
  test('an unnamed job is named by the file that declared it, never an unrelated example', () => {
    const caught = declareUnkeyed();
    expect(caught.code).toBe('X_IDEMPOTENCY_REQUIRED');
    expect(caught.cause).toContain('packages/jobs/src/errors-idempotency.test.ts:');
    expect(caught.fix).toStartWith(
      `idempotencyKey: (input) => \`errorsIdempotencyTest:\${input.id}\``,
    );
    expect(caught.fix).toContain('packages/jobs/src/errors-idempotency.test.ts:');
    expect(caught.fix).not.toContain('syncInvoices');
    expect(caught.fix).not.toContain('anonymous-job');
  });

  test('a named job keeps its name in the key and the cause', () => {
    const caught = new IdempotencyRequiredError({ job: 'sendReminder' });
    expect(caught.cause).toContain('job "sendReminder"');
    expect(caught.fix).toStartWith(`idempotencyKey: (input) => \`sendReminder:\${input.id}\``);
  });

  test("the site skips this package's frames and node_modules, keeping the declaring file", () => {
    const stack = [
      'Error',
      '    at job (/app/node_modules/@ultimat3/jobs/dist/job.js:94:11)',
      '    at /app/apps/web/app/reminder/jobs/send-reminder.ts:7:29',
    ].join('\n');
    expect(declarationSite(stack, '/app')).toEqual({
      file: 'apps/web/app/reminder/jobs/send-reminder.ts',
      line: 7,
    });
    expect(declarationSite('Error', '/app')).toBeUndefined();
  });
});
