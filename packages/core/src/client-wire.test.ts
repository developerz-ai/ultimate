/**
 * unit — no socket. What a typed client puts on the wire and reads back off it: the trace header
 * it may send, the problem body it may read, and the classification a status is allowed to give.
 */

import { describe, expect, test } from 'bun:test';
import { FRAMEWORK_CODE, problemOf, retryForStatus, traceHeaders } from './client-wire';
import { createContext, runWithContext } from './context';
import { parseTraceparent, withSpan } from './telemetry';

describe('traceHeaders', () => {
  test('inside a span, the header continues the CALLER’s trace', () => {
    const { sent, traceId } = withSpan('a.calls.b', (span) => ({
      sent: traceHeaders(),
      traceId: span.context.traceId,
    }));

    expect(parseTraceparent(sent['traceparent'])?.traceId).toBe(traceId);
  });

  test('with no ambient trace at all, nothing is sent', () => {
    // The browser case: acquiring a header here is acquiring a CORS preflight nobody asked for.
    expect(traceHeaders()).toEqual({});
  });

  test('an INCOMPLETE context sends nothing rather than a header every collector drops', () => {
    // `currentSpanContext()` answers a request context with an empty `spanId`, which renders
    // `00-<trace>--01`. Half a header is worse than none: it is dropped AND it costs the preflight.
    const sent = runWithContext(createContext(), () => traceHeaders());
    expect(sent).toEqual({});
  });
});

describe('FRAMEWORK_CODE', () => {
  test('accepts the one spelling a code has', () => {
    expect(FRAMEWORK_CODE.test('X_TIMEOUT')).toBe(true);
    expect(FRAMEWORK_CODE.test('X_FLIGHT_GATE_OVERLOADED')).toBe(true);
    expect(FRAMEWORK_CODE.test('X_HTTP2')).toBe(true);
  });

  test('rejects what `typeof code === "string"` alone accepted off a gateway', () => {
    // Both shipped: an empty code and a lowercase word rendered `: ` under a humanised title.
    expect(FRAMEWORK_CODE.test('')).toBe(false);
    expect(FRAMEWORK_CODE.test('error')).toBe(false);
    expect(FRAMEWORK_CODE.test('X_')).toBe(false);
    expect(FRAMEWORK_CODE.test('X_lower')).toBe(false);
    expect(FRAMEWORK_CODE.test('X_TRAILING_')).toBe(false);
    expect(FRAMEWORK_CODE.test('Y_TIMEOUT')).toBe(false);
  });
});

describe('problemOf is TOTAL', () => {
  test('an application/problem+json body is handed back as the record it is', () => {
    expect(problemOf('{"code":"X_TIMEOUT","cause":"slow"}')).toEqual({
      code: 'X_TIMEOUT',
      cause: 'slow',
    });
  });

  test('everything a proxy answers instead of the app is `{}`, never a throw', () => {
    // Each of these reached the FAILURE path, where a second throw replaces the real refusal.
    expect(problemOf('<html>502 Bad Gateway</html>')).toEqual({});
    expect(problemOf('')).toEqual({});
    expect(problemOf('{"code":"X_TIMEOUT"')).toEqual({});
    expect(problemOf('[{"code":"X_TIMEOUT"}]')).toEqual({});
    expect(problemOf('null')).toEqual({});
    expect(problemOf('"a string body"')).toEqual({});
  });
});

describe('retryForStatus', () => {
  test('a DECLARED classification stands, whatever the status was', () => {
    // `X_NOT_IMPLEMENTED` behind a 501 is a permanent answer somebody already gave; a status that
    // overrode it would have a client hammer a service that refuses it identically forever.
    expect(retryForStatus('X_NOT_IMPLEMENTED', 501)).toBeUndefined();
    expect(retryForStatus('X_TIMEOUT', 400)).toBeUndefined();
  });

  test('with nobody having declared one, the STATUS decides', () => {
    // Without this every 502 out of a typed client read as `terminal`, because `UltimateError`
    // fills `retry` from `retryFor(code)`, which fails closed.
    expect(retryForStatus('X_APP_UNDECLARED', 502)).toBe('retryable');
    expect(retryForStatus('X_APP_UNDECLARED', 429)).toBe('retryable');
    expect(retryForStatus('X_APP_UNDECLARED', 400)).toBeUndefined();
    expect(retryForStatus('X_APP_UNDECLARED', 404)).toBeUndefined();
  });
});
