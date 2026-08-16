import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import {
  OTLP_ENDPOINT_KEY,
  OTLP_HEADERS_KEY,
  OTLP_PROTOCOL_KEY,
  otlpAttributes,
  otlpEndpoint,
  otlpHeaders,
  otlpResource,
  tryOtlpEndpoint,
  unixNano,
} from './otlp';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : 'not-ultimate';
  }
  return 'no-throw';
};

describe('otlpEndpoint', () => {
  test('refuses the gRPC receiver by port, and names 4318 in the fix', () => {
    const env = { [OTLP_ENDPOINT_KEY]: 'http://otel-collector:4317' };
    expect(codeOf(() => otlpEndpoint('traces', undefined, env))).toBe(
      'X_OTLP_PROTOCOL_UNSUPPORTED',
    );
    try {
      otlpEndpoint('traces', undefined, env);
    } catch (thrown) {
      expect(isUltimateError(thrown) && thrown.fix).toContain('4318');
    }
  });

  test('refuses a protocol this exporter does not speak', () => {
    const env = {
      [OTLP_ENDPOINT_KEY]: 'http://otel-collector:4318',
      [OTLP_PROTOCOL_KEY]: 'grpc',
    };
    expect(codeOf(() => otlpEndpoint('traces', undefined, env))).toBe(
      'X_OTLP_PROTOCOL_UNSUPPORTED',
    );
  });

  test('refuses a non-URL and a non-HTTP scheme', () => {
    expect(codeOf(() => otlpEndpoint('traces', 'otel-collector:4318', {}))).toBe(
      'X_OTLP_ENDPOINT_INVALID',
    );
    expect(codeOf(() => otlpEndpoint('metrics', 'grpc://collector/', {}))).toBe(
      'X_OTLP_ENDPOINT_INVALID',
    );
  });

  test('names the variable to set when nothing configured one', () => {
    expect(codeOf(() => otlpEndpoint('traces', undefined, {}))).toBe('X_OTLP_ENDPOINT_INVALID');
  });

  test('appends the signal path to the generic endpoint, once', () => {
    expect(tryOtlpEndpoint('traces', { [OTLP_ENDPOINT_KEY]: 'http://c:4318' })).toBe(
      'http://c:4318/v1/traces',
    );
    expect(tryOtlpEndpoint('metrics', { [OTLP_ENDPOINT_KEY]: 'http://c:4318/' })).toBe(
      'http://c:4318/v1/metrics',
    );
  });

  test('takes a per-signal endpoint verbatim — it is already the full URL', () => {
    const env = {
      [OTLP_ENDPOINT_KEY]: 'http://generic:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://tempo.example/otlp/v1/traces',
    };
    expect(tryOtlpEndpoint('traces', env)).toBe('https://tempo.example/otlp/v1/traces');
    expect(tryOtlpEndpoint('metrics', env)).toBe('http://generic:4318/v1/metrics');
  });

  test('undefined, not a throw, when an operator configured nothing', () => {
    expect(tryOtlpEndpoint('traces', {})).toBeUndefined();
    expect(tryOtlpEndpoint('traces', { [OTLP_ENDPOINT_KEY]: '  ' })).toBeUndefined();
  });
});

describe('otlpHeaders', () => {
  test('parses the comma-separated env form and percent-decodes the value', () => {
    const headers = otlpHeaders(undefined, {
      [OTLP_HEADERS_KEY]: 'Api-Key=abc%20123,x-tenant=acme',
    });
    expect(headers['api-key']).toBe('abc 123');
    expect(headers['x-tenant']).toBe('acme');
    expect(headers['content-type']).toBe('application/json');
  });

  test('an explicit header wins over the env', () => {
    const headers = otlpHeaders({ 'Api-Key': 'explicit' }, { [OTLP_HEADERS_KEY]: 'api-key=env' });
    expect(headers['api-key']).toBe('explicit');
  });
});

describe('otlpAttributes', () => {
  test('encodes each AttributeValue as the OTLP variant it belongs to', () => {
    expect(
      otlpAttributes({ s: 'x', b: true, i: 7, d: 1.5, list: ['a', 'b'] as readonly string[] }),
    ).toEqual([
      { key: 's', value: { stringValue: 'x' } },
      { key: 'b', value: { boolValue: true } },
      { key: 'i', value: { intValue: '7' } },
      { key: 'd', value: { doubleValue: 1.5 } },
      {
        key: 'list',
        value: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
      },
    ]);
  });
});

describe('unixNano', () => {
  test('is a string of nanoseconds, exact past 2^53 nanoseconds', () => {
    expect(unixNano(1_767_225_600_000)).toBe('1767225600000000000');
  });
});

describe('otlpResource', () => {
  test('carries the service identity every signal shares', () => {
    expect(otlpResource({ serviceName: 'web', serviceVersion: '1.2.0' })).toEqual({
      attributes: [
        { key: 'service.name', value: { stringValue: 'web' } },
        { key: 'service.version', value: { stringValue: '1.2.0' } },
      ],
    });
  });
});
