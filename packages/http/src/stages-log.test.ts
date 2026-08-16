// The `error-map` stage's one log line, driven through the real stage runner with a real
// context. `logger.emit()` redacts `bound`, `contextFields` and `fields` — and never `msg` — so
// a cause interpolated into the message reached the log store past every rule that exists to
// stop it. A rejected `{"password":"…"}` was written verbatim, at 4xx, which is logged and not
// reported and therefore kept for the full retention.
import { describe, expect, test } from 'bun:test';
import { createLogger } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createRequestContext } from './context';
import { bodyInvalid } from './errors';
import { UltimateRequest } from './request';
import { createRouter } from './router';
import { stageRunners } from './stages';

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });

const runErrorMap = async (error: unknown): Promise<Record<string, unknown>[]> => {
  const lines: Record<string, unknown>[] = [];
  const url = new URL('http://app.test/login');
  const ctx = createRequestContext({
    url,
    method: 'POST',
    role: 'web',
    config,
    logger: createLogger({
      level: 'error',
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  ctx.error = error;
  const run = stageRunners({
    table: createRouter([]),
    config,
    limiter: {
      scope: 'process',
      check: async () => never(),
      headers: () => ({}),
      assert: async () => never(),
    },
    hooks: {},
    middleware: [],
  });
  await run['error-map'](new UltimateRequest(new Request(url, { method: 'POST' }), ctx), ctx);
  return lines;
};

const never = (): never => {
  throw new Error('the limiter is not consulted by the error-map stage');
};

describe('the error-map log line', () => {
  test('msg is the CODE alone — nothing variable is interpolated into it', async () => {
    const [line] = await runErrorMap(
      bodyInvalid('/login', ['password: expected at least 12 chars, received a string of 7']),
    );
    expect(line?.['msg']).toBe('X_BODY_INVALID');
  });

  test('the cause is a FIELD, which is the only path redaction can reach', async () => {
    const [line] = await runErrorMap(
      bodyInvalid('/login', ['password: expected at least 12 chars, received a string of 7']),
    );
    expect(String(line?.['cause'])).toContain('password:');
    expect(line?.['status']).toBe(422);
  });

  // The regression, stated as the property rather than as one value: whatever a cause carries,
  // the message never carries it too.
  test('the message never repeats the cause', async () => {
    const [line] = await runErrorMap(bodyInvalid('/login', ['password: received a secret']));
    expect(String(line?.['msg'])).not.toContain('secret');
    expect(String(line?.['msg'])).not.toContain('password');
  });

  // The line goes through `ctx.logger`, the child `createRequestContext` builds — which is the
  // member `asCtx` used to assert and never set.
  test('the line carries the request and trace ids without being told', async () => {
    const [line] = await runErrorMap(bodyInvalid('/login', ['nope']));
    expect(String(line?.['requestId']).length).toBeGreaterThan(0);
    expect(String(line?.['traceId'])).toMatch(/^[0-9a-f]{32}$/);
  });
});
