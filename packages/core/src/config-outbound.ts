// Single responsibility: the `outbound` block of `app.config.ts` — the app-wide egress proxy every
// `outbound()` call takes unless it names its own, and the hosts that never do. Shape, merge and
// screen are one subject; `config.ts` is full. The boot installs it (`outbound-default-proxy.ts`).

import { describeValue, renderCauseValue } from './error-render';

/**
 * NO PROXY BY DEFAULT: a deploy behind an egress gateway says so. `proxy` is an `http:`/`https:`
 * URL; its credential belongs in the environment (`proxy: env.EGRESS_PROXY`, through
 * `defineEnv`), never a literal in a committed file. `direct` hosts — and every name under each, and loopback always —
 * dial without it: an in-cluster collector or sidecar is not egress.
 */
export interface OutboundConfig {
  readonly proxy: string | undefined;
  readonly direct: readonly string[];
}

export const OUTBOUND_DEFAULTS: OutboundConfig = Object.freeze({ proxy: undefined, direct: [] });

export interface OutboundSection {
  readonly outbound: OutboundConfig;
}

export interface OutboundSectionInput {
  readonly outbound?:
    | {
        readonly proxy?: string | undefined;
        readonly direct?: readonly string[] | undefined;
      }
    | undefined;
}

/** Each key is the last layer that said it; `direct` is one list, replaced whole like `roles`. */
export function mergeOutbound(layers: readonly OutboundSectionInput[]): OutboundSection {
  let { proxy, direct } = OUTBOUND_DEFAULTS;
  for (const layer of layers) {
    if (layer.outbound?.proxy !== undefined) proxy = layer.outbound.proxy;
    if (layer.outbound?.direct !== undefined) direct = layer.outbound.direct;
  }
  return { outbound: { proxy, direct } };
}

/** The schemes Bun's `fetch` tunnels through — `outbound-proxy.ts` refuses the rest per hop. */
const PROXY_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** A bare host name or IPv4 literal, or a bracketed IPv6 one: what a URL's `hostname` holds. */
const HOST =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/i;

/** Why `proxy` cannot be used, in words that never quote it: the URL may carry a password. */
function proxyIssue(proxy: unknown): string | undefined {
  if (proxy === undefined) return undefined;
  const rule = 'outbound.proxy must be an absolute http: or https: URL';
  if (typeof proxy !== 'string') return `${rule}, not ${describeValue(proxy)}`;
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return `${rule}; the value set is not a URL (not echoed: it may hold a credential)`;
  }
  return PROXY_SCHEMES.has(url.protocol) ? undefined : `${rule}, not ${url.protocol}`;
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function outboundIssues(
  config: { readonly outbound?: OutboundConfig | undefined },
  issues: string[],
): void {
  const section = config.outbound ?? OUTBOUND_DEFAULTS;
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const proxy: unknown = section.proxy;
  const issue = proxyIssue(proxy);
  if (issue !== undefined) issues.push(issue);
  for (const entry of section.direct as readonly unknown[]) {
    if (typeof entry !== 'string' || !HOST.test(entry)) {
      issues.push(
        `outbound.direct holds ${typeof entry === 'string' ? renderCauseValue(entry) : describeValue(entry)}, not a bare host name (no scheme, path, port or *)`,
      );
    }
  }
}
