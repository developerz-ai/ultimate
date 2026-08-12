// Locked security headers. The CSP admits exactly what the framework itself emits — a service
// worker, wasm, and the inline `<style>` every document carries — so widening it is a visible
// config change. Inline style is admitted by sha256 hash, never `'unsafe-inline'`: a prerendered
// document is a file on disk, so no per-response nonce can reach it, but its body is fixed.

import { OVERLAY_STYLE } from './overlay-style';

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

/**
 * `'sha256-<base64>'` for the exact text an inline `<style>` or `<script>` holds, ready to
 * concatenate into a directive. A hash and not a nonce because the two documents that most need
 * covering cannot receive one: a prerendered page is a file on disk, and a response's `<style>` is
 * built by the handler, after the stage that would have had to choose the nonce.
 */
export const cspHashSource = (body: string): string =>
  `'sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}'`;

/** Directive -> sources. Inline bodies are admitted by hash; `config.csp.extend` adds the rest. */
const baseline = (config: SecurityConfig): Record<string, readonly string[]> => ({
  'default-src': ["'self'"],
  // 'wasm-unsafe-eval' only: no 'unsafe-inline', no 'unsafe-eval'.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  // The dev overlay is the one document this package renders itself, so its hash is the one
  // `style-src` source that is not the caller's to supply. Unconditional rather than gated on
  // `dev`: a header that changes with a runtime branch is a header a CDN caches for the wrong
  // document, and admitting a stylesheet the framework wrote grants an attacker nothing.
  'style-src': ["'self'", cspHashSource(OVERLAY_STYLE)],
  // ATTRIBUTES ONLY, and the one relaxation in this file. Every layout composite sizes itself
  // with `style="--shell-sidebar: 16rem"`, computed per render, so there is no fixed text to
  // hash and `'unsafe-hashes'` cannot express it. `style-src` still governs `<style>` ELEMENTS,
  // so a `defineTheme()` value carrying `</style>` is still a refusal and not an injection.
  'style-src-attr': ["'unsafe-inline'"],
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

export const buildCsp = (config: SecurityConfig): string => {
  const directives = baseline(config);
  for (const [name, sources] of Object.entries(config.csp.extend)) {
    directives[name] = [...(directives[name] ?? []), ...sources];
  }
  const parts = Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`);
  if (config.csp.reportUri !== null) parts.push(`report-uri ${config.csp.reportUri}`);
  return parts.join('; ');
};

export const securityHeaders = (
  config: SecurityConfig,
  options: { https?: boolean } = {},
): Record<string, string> => {
  const cspHeader = config.csp.reportOnly
    ? 'content-security-policy-report-only'
    : 'content-security-policy';
  const headers: Record<string, string> = {
    [cspHeader]: buildCsp(config),
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
