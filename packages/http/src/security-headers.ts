// Locked security headers. The CSP is written to work with the three things the
// framework actually ships — a service worker, streamed HTML with a hydration
// nonce, and wasm — and nothing else, so widening it is a visible config change.

export interface SecurityConfig {
  readonly csp: {
    /** Extra sources per directive, merged into the locked baseline. */
    readonly extend: Readonly<Record<string, readonly string[]>>;
    readonly reportUri: string | null;
    /** `true` sends Content-Security-Policy-Report-Only instead. Dev default. */
    readonly reportOnly: boolean;
  };
  readonly hsts: {
    readonly maxAgeSeconds: number;
    readonly includeSubdomains: boolean;
    readonly preload: boolean;
  } | null;
  readonly frameAncestors: readonly string[];
  readonly referrerPolicy: string;
  readonly permissionsPolicy: string;
  readonly coop: string;
  readonly corp: string;
}

export const DEFAULT_SECURITY: SecurityConfig = {
  csp: { extend: {}, reportUri: null, reportOnly: false },
  frameAncestors: ["'none'"],
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=()',
  coop: 'same-origin',
  corp: 'same-origin',
  hsts: { maxAgeSeconds: 63_072_000, includeSubdomains: true, preload: false },
};

/** Directive -> sources. `'nonce-*'` is injected per response, never stored here. */
const baseline = (config: SecurityConfig): Record<string, readonly string[]> => ({
  'default-src': ["'self'"],
  // 'wasm-unsafe-eval' only: no 'unsafe-inline', no 'unsafe-eval'.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  // ws:/wss: are required by the realtime tiers; blob: by streamed responses.
  'connect-src': ["'self'", 'ws:', 'wss:', 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'media-src': ["'self'", 'blob:'],
  'frame-ancestors': config.frameAncestors,
  'form-action': ["'self'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
});

export const buildCsp = (config: SecurityConfig, nonce?: string): string => {
  const directives = baseline(config);
  for (const [name, sources] of Object.entries(config.csp.extend)) {
    directives[name] = [...(directives[name] ?? []), ...sources];
  }
  if (nonce !== undefined) {
    directives['script-src'] = [...(directives['script-src'] ?? []), `'nonce-${nonce}'`];
  }
  const parts = Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`);
  if (config.csp.reportUri !== null) parts.push(`report-uri ${config.csp.reportUri}`);
  return parts.join('; ');
};

export const securityHeaders = (
  config: SecurityConfig,
  options: { nonce?: string; https?: boolean } = {},
): Record<string, string> => {
  const cspHeader = config.csp.reportOnly
    ? 'content-security-policy-report-only'
    : 'content-security-policy';
  const headers: Record<string, string> = {
    [cspHeader]: buildCsp(config, options.nonce),
    'x-content-type-options': 'nosniff',
    'referrer-policy': config.referrerPolicy,
    'permissions-policy': config.permissionsPolicy,
    'cross-origin-opener-policy': config.coop,
    'cross-origin-resource-policy': config.corp,
  };
  // HSTS over plaintext is ignored by browsers and confuses local dev, so skip it.
  if (config.hsts !== null && options.https !== false) {
    const parts = [`max-age=${config.hsts.maxAgeSeconds}`];
    if (config.hsts.includeSubdomains) parts.push('includeSubDomains');
    if (config.hsts.preload) parts.push('preload');
    headers['strict-transport-security'] = parts.join('; ');
  }
  return headers;
};
