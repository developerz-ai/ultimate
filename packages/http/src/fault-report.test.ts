// A fault after the response left is recorded as the `error-map` stage would have — once — and a
// caller's hang-up is told apart from a defect that merely happened after one.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  InternalError,
  memoryErrorReporter,
  resetErrorReporting,
  runWithContext,
  withChildContext,
} from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';
import { routeNotFound } from './errors';
import { answerableError, bindLateFault, isCallerAbort, reportLateFault } from './fault-report';
import { resetRefusalLog } from './refusal-log';

const reporter = memoryErrorReporter();
const fault = () => new InternalError({ cause: 'the store went away', fix: 'bun run x -- doctor' });

const request = (signal?: AbortSignal) =>
  requestContext({
    url: new URL('http://app.test/feed'),
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    ...(signal === undefined ? {} : { signal }),
  });

beforeEach(() => {
  resetRefusalLog();
  resetErrorReporting();
  reporter.reset();
  installErrorReporter(reporter);
});

afterEach(() => resetErrorReporting());

describe('reportLateFault', () => {
  test('records a 5xx with the monitor and the app sink, exactly once per request', () => {
    const ctx = request();
    const seen: unknown[] = [];
    bindLateFault(ctx, { onError: (error) => void seen.push(error) });
    const error = fault();

    expect(reportLateFault(error, asCtx(ctx))).toBe(true);
    expect(reportLateFault(fault(), asCtx(ctx))).toBe(true);

    expect(seen).toEqual([error]);
    expect(reporter.events).toHaveLength(1);
    expect(reporter.events[0]?.scope.operation).toBe('GET unmatched');
    expect(reporter.events[0]?.scope.requestId).toBe(ctx.requestId);
  });

  test('finds the request from a context derived inside it, through the ambient one', () => {
    const ctx = request();
    const seen: unknown[] = [];
    bindLateFault(ctx, { onError: (error) => void seen.push(error) });

    const recorded = runWithContext(asCtx(ctx), () =>
      withChildContext({ signal: new AbortController().signal }, () => reportLateFault(fault())),
    );

    expect(recorded).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('a 4xx reaches the app sink and never the monitor', () => {
    const ctx = request();
    const seen: unknown[] = [];
    bindLateFault(ctx, { onError: (error) => void seen.push(error) });

    reportLateFault(routeNotFound('GET', '/feed'), asCtx(ctx));

    expect(seen).toHaveLength(1);
    expect(reporter.events).toEqual([]);
  });

  test('answers false with no pipeline request behind the context, and records nothing', () => {
    expect(reportLateFault(fault(), ctxOf({}))).toBe(false);
    expect(reportLateFault(fault(), undefined)).toBe(false);
    expect(reporter.events).toEqual([]);
  });

  // The stream's producer unwinds on the abort when its reader leaves: nobody is there to answer
  // and nothing failed. Asked here, so a caller of this function never judges a hang-up itself.
  test("a caller's hang-up is nobody's incident: nothing recorded, the one report unspent", () => {
    const caller = new AbortController();
    const ctx = request(caller.signal);
    const seen: unknown[] = [];
    bindLateFault(ctx, { onError: (error) => void seen.push(error) });
    caller.abort(new DOMException('The connection was closed.', 'AbortError'));

    expect(reportLateFault(caller.signal.reason, asCtx(ctx))).toBe(true);
    expect(seen).toEqual([]);
    expect(reporter.events).toEqual([]);

    // A defect that merely happened after the hang-up is still a defect, and still reported.
    const defect = fault();
    expect(reportLateFault(defect, asCtx(ctx))).toBe(true);
    expect(seen).toEqual([defect]);
    expect(reporter.events).toHaveLength(1);
  });

  test('a hang-up on a signal a derived context added is read from that context', () => {
    const ctx = request();
    const seen: unknown[] = [];
    bindLateFault(ctx, { onError: (error) => void seen.push(error) });
    const left = new AbortController();
    runWithContext(asCtx(ctx), () =>
      withChildContext({ signal: left.signal }, () => {
        left.abort();
        expect(reportLateFault(left.signal.reason)).toBe(true);
      }),
    );
    expect(seen).toEqual([]);
  });

  test('a sink that throws is contained: nothing is above a late fault', () => {
    const ctx = request();
    bindLateFault(ctx, {
      // A sink that throws on its own: the parse does, with no verdict of this test's in it.
      onError: () => void JSON.parse('{'),
    });
    expect(reportLateFault(fault(), asCtx(ctx))).toBe(true);
  });
});

describe('isCallerAbort', () => {
  const hangUp = () => new DOMException('The connection was closed.', 'AbortError');

  test('the uncoded reason itself, or an AbortError raised for it, after the caller left', () => {
    const caller = new AbortController();
    const reason = hangUp();
    expect(isCallerAbort(reason, caller.signal)).toBe(false);
    caller.abort(reason);
    expect(isCallerAbort(reason, caller.signal)).toBe(true);
    expect(isCallerAbort(hangUp(), caller.signal)).toBe(true);
    expect(isCallerAbort(new TypeError('a defect after the hang-up'), caller.signal)).toBe(false);
  });

  test('a CODED abort — the deadline, a drain — is never the caller leaving', () => {
    const deadline = new AbortController();
    const coded = fault();
    deadline.abort(coded);
    expect(isCallerAbort(coded, deadline.signal)).toBe(false);
    expect(isCallerAbort(hangUp(), deadline.signal)).toBe(false);
  });

  test('answerableError swaps only the hang-up for X_ABORTED', () => {
    const caller = new AbortController();
    const ctx = request(caller.signal);
    const defect = new TypeError('a defect');
    expect(answerableError(defect, ctx)).toBe(defect);
    caller.abort(hangUp());
    expect(answerableError(defect, ctx)).toBe(defect);
    expect(answerableError(caller.signal.reason, ctx)).toMatchObject({ code: 'X_ABORTED' });
  });
});
