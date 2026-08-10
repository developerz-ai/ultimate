import { describe, expect, test } from 'bun:test';
import type { SecurityConfig } from './security-headers';
import { buildCsp, DEFAULT_SECURITY, securityHeaders } from './security-headers';

describe('buildCsp()', () => {
  test('the default policy is a locked baseline with no unsafe- sources', () => {
    const csp = buildCsp(DEFAULT_SECURITY);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    // ';'-joined directive list, each a "name sources..." pair.
    for (const part of csp.split('; ')) {
      expect(part).toMatch(/^[a-z-]+ .+/);
    }
  });

  test('config.csp.extend appends sources to an existing directive', () => {
    const config: SecurityConfig = {
      ...DEFAULT_SECURITY,
      csp: { ...DEFAULT_SECURITY.csp, extend: { 'connect-src': ['https://api.example.com'] } },
    };
    const csp = buildCsp(config);
    const connectSrc = csp.split('; ').find((part) => part.startsWith('connect-src'));
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain('ws:');
    expect(connectSrc).toContain('https://api.example.com');
  });

  test('config.csp.extend can introduce a directive absent from the baseline', () => {
    const config: SecurityConfig = {
      ...DEFAULT_SECURITY,
      csp: { ...DEFAULT_SECURITY.csp, extend: { 'prefetch-src': ["'self'"] } },
    };
    const csp = buildCsp(config);
    expect(csp).toContain("prefetch-src 'self'");
  });

  test('a nonce is appended to script-src alongside the existing sources', () => {
    const csp = buildCsp(DEFAULT_SECURITY, 'abc123');
    const scriptSrc = csp.split('; ').find((part) => part.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self' 'wasm-unsafe-eval' 'nonce-abc123'");
  });

  test('reportUri appends a report-uri directive when set, omits it when null', () => {
    const withReport = buildCsp({
      ...DEFAULT_SECURITY,
      csp: { ...DEFAULT_SECURITY.csp, reportUri: 'https://csp.example.com/report' },
    });
    expect(withReport).toContain('report-uri https://csp.example.com/report');
    expect(withReport.endsWith('report-uri https://csp.example.com/report')).toBe(true);

    const withoutReport = buildCsp(DEFAULT_SECURITY);
    expect(withoutReport).not.toContain('report-uri');
  });
});

describe('securityHeaders()', () => {
  test('reportOnly false uses content-security-policy, not the report-only variant', () => {
    const headers = securityHeaders(DEFAULT_SECURITY);
    expect(headers['content-security-policy']).toBeDefined();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
  });

  test('reportOnly true uses content-security-policy-report-only instead', () => {
    const config: SecurityConfig = {
      ...DEFAULT_SECURITY,
      csp: { ...DEFAULT_SECURITY.csp, reportOnly: true },
    };
    const headers = securityHeaders(config);
    expect(headers['content-security-policy-report-only']).toBeDefined();
    expect(headers['content-security-policy']).toBeUndefined();
  });

  test('fixed headers always match the config values', () => {
    const headers = securityHeaders(DEFAULT_SECURITY);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe(DEFAULT_SECURITY.referrerPolicy);
    expect(headers['permissions-policy']).toBe(DEFAULT_SECURITY.permissionsPolicy);
    expect(headers['cross-origin-opener-policy']).toBe(DEFAULT_SECURITY.coop);
    expect(headers['cross-origin-resource-policy']).toBe(DEFAULT_SECURITY.corp);
  });

  test('hsts present with both includeSubDomains and preload when configured true', () => {
    const config: SecurityConfig = {
      ...DEFAULT_SECURITY,
      hsts: { maxAgeSeconds: 12_345, includeSubdomains: true, preload: true },
    };
    const headers = securityHeaders(config);
    expect(headers['strict-transport-security']).toBe('max-age=12345; includeSubDomains; preload');
  });

  test('hsts omits includeSubDomains/preload tokens when configured false', () => {
    const config: SecurityConfig = {
      ...DEFAULT_SECURITY,
      hsts: { maxAgeSeconds: 12_345, includeSubdomains: false, preload: false },
    };
    const headers = securityHeaders(config);
    expect(headers['strict-transport-security']).toBe('max-age=12345');
  });

  test('hsts is skipped over plaintext even when configured, since browsers ignore it there', () => {
    const headers = securityHeaders(DEFAULT_SECURITY, { https: false });
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  test('hsts is present by default (https not explicitly false)', () => {
    const headers = securityHeaders(DEFAULT_SECURITY);
    expect(headers['strict-transport-security']).toBeDefined();
  });

  test('hsts null omits the header regardless of https option', () => {
    const config: SecurityConfig = { ...DEFAULT_SECURITY, hsts: null };
    expect(securityHeaders(config)['strict-transport-security']).toBeUndefined();
    expect(securityHeaders(config, { https: true })['strict-transport-security']).toBeUndefined();
  });
});

describe('DEFAULT_SECURITY', () => {
  test('ships a report-only-off, no-report-uri, empty-extend baseline', () => {
    expect(DEFAULT_SECURITY.csp.extend).toEqual({});
    expect(DEFAULT_SECURITY.csp.reportUri).toBeNull();
    expect(DEFAULT_SECURITY.csp.reportOnly).toBe(false);
    expect(DEFAULT_SECURITY.hsts).not.toBeNull();
  });
});
