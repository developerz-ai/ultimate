/**
 * `ssr` — per-request full render. The whole document waits for the slowest dependency,
 * which is exactly the trade you want for a fresh SEO page and exactly the trade you do
 * not want for an app page (use `stream`).
 */

import type { Ctx } from '@ultimat3/core';
import type { RouteEntry } from './registry';
import type { RenderResult, RouteParams } from './route';

export interface SsrRenderInput {
  readonly entry: RouteEntry;
  readonly params: RouteParams;
  readonly url: URL;
  readonly ctx: Ctx;
}

export type SsrRenderFn = (input: SsrRenderInput) => string | Promise<string>;

export interface SsrOptions {
  readonly buildId: string;
  /** Extra `Vary` dimensions beyond the defaults. */
  readonly vary?: readonly string[];
  readonly status?: number;
}

export async function renderSsr(
  input: SsrRenderInput,
  render: SsrRenderFn,
  options: SsrOptions,
): Promise<RenderResult> {
  const html = await render(input);
  return {
    status: options.status ?? 200,
    headers: ssrHeaders(input.entry, options),
    body: html,
  };
}

/**
 * A gated page is never shared cache material: one actor's HTML in a CDN is the same bug
 * class as a cache key missing its tenant.
 */
export function ssrHeaders(
  entry: RouteEntry,
  options: SsrOptions,
): Readonly<Record<string, string>> {
  const gated = entry.config.policy !== undefined;
  const vary = new Set<string>(['accept-language', ...(options.vary ?? [])]);
  if (gated) vary.add('cookie');

  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': gated
      ? 'private, no-store'
      : 'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    vary: [...vary].sort().join(', '),
    'x-ultimate-build': options.buildId,
  };
}
