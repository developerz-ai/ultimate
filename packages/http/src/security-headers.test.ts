// A security header is worth only what the browser does with it, and every mistake here
// fails open and silent: a CSP widened by one source, a report-only policy shipped to
// production, an HSTS header sent over plaintext where it is ignored outright. These tests
// pin the locked baseline and each way config is allowed to move it.
import { describe, expect, test } from 'bun:test';
import { OVERLAY_STYLE } from './overlay-style';
import type { SecurityConfig } from './security-headers';
import { buildCsp, cspHashSource, DEFAULT_SECURITY, securityHeaders } from './security-headers';

const directive = (csp: string, name: string): string =>
  csp.split('; ').find((part) => part.startsWith(`${name} `)) ?? `${name} <absent>`;

describe('buildCsp()', () => {
  test('the default policy is a locked baseline with no unsafe- sources', () => {
    const csp = buildCsp(DEFAULT_SECURITY);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    // Elements stay locked: nothing may execute or paint on the strength of being inline.
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'style-src')).not.toContain("'unsafe-inline'");
    // The ONE relaxation, and it is attribute-scoped — see the comment on the baseline.
    expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
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

  test('style-src carries the dev overlay hash, so http covers its own document', () => {
    // The regression: the CSP was written for documents nobody could hash and none for the ones
    // the framework actually emits, so every inline `<style>` it wrote was refused by it.
    expect(directive(buildCsp(DEFAULT_SECURITY), 'style-src')).toContain(
      cspHashSource(OVERLAY_STYLE),
    );
  });

  test('a style hash from extend joins the baseline rather than replacing it', () => {
    const hash = cspHashSource('body{color:red}');
    const csp = buildCsp({
      ...DEFAULT_SECURITY,
      csp: { ...DEFAULT_SECURITY.csp, extend: { 'style-src': [hash] } },
    });
    expect(directive(csp, 'style-src')).toContain("'self'");
    expect(directive(csp, 'style-src')).toContain(hash);
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

describe('cspHashSource()', () => {
  test('is the base64 sha256 of the body, quoted the way a directive takes it', () => {
    const body = 'main{display:grid}';
    const digest = new Bun.CryptoHasher('sha256').update(body).digest('base64');
    expect(cspHashSource(body)).toBe(`'sha256-${digest}'`);
  });

  test('a single changed byte is a different source — the point of hashing the body', () => {
    expect(cspHashSource('a{color:red}')).not.toBe(cspHashSource('a{color:red} '));
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
