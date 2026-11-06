// Single responsibility: the server half of real-user timings — `GET /x-client-vitals.js` and
// `POST /_client-vitals`, which turns one beacon into histogram samples labelled by route PATTERN
// and metric. Anonymous, stored nowhere but the metric: no actor, no path, no row. A framework
// route like `/_client-errors`, never an action: it must not appear in OpenAPI or as an MCP tool.

import type { ClientVitalsConfig, ClientVitalsSurface } from '@ultimat3/core';
import { histogram, isJsonObject, proveSameOrigin, readWithinLimit } from '@ultimat3/core';
import type { RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { NO_STORE, selfOrigin } from '@ultimat3/http';
import { routeEntries } from '@ultimat3/render';
import type { ClientErrorPage } from './client-errors-routes';
import {
  CLIENT_VITAL_NAMES,
  CLIENT_VITALS_PATH,
  CLIENT_VITALS_SCRIPT_PATH,
  type ClientVitalName,
  clientVitalsHead,
  clientVitalsScript,
} from './client-vitals-script';
import { revalidatedResponse } from './revalidated-response';

/** A beacon is one path and five numbers; 4 KiB is that with room, and nothing more. */
export const CLIENT_VITALS_MAX_BODY_BYTES = 4 * 1024;

/** One beacon per page view: sixty a minute per address is a reader opening a page a second. */
export const CLIENT_VITALS_PER_MINUTE = 60;

/** A timing past a minute is a backgrounded tab's clock, not what a user waited for. */
const MAX_MS = 60_000;
/** CLS is unitless; real pages sit under 1, and a value past 10 is a measurement gone wrong. */
const MAX_CLS = 10;

/** A path, never a URL and never a query: the same screen `/_client-errors` applies. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class REFUSES them, by design.
const PATH = /^\/[^?#\s\x00-\x1f\x7f]{0,2047}$/;

const NAMES: ReadonlySet<string> = new Set(CLIENT_VITAL_NAMES);
const isVitalName = (name: string): name is ClientVitalName => NAMES.has(name);

/**
 * Two instruments, declared once. Labels are `route` (a pattern from the route table) and `metric`
 * (one of four), so the series count is the page count times four, whatever the traffic sends.
 */
const seconds = histogram('web_vital_seconds', {
  unit: 's',
  description: 'Real-user page timings (LCP, FCP, INP, TTFB), by route pattern and metric',
  bounds: [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.8, 2.5, 3, 4, 6, 10, 20, 60],
});
const shift = histogram('web_vital_cls', {
  unit: '1',
  description: 'Real-user cumulative layout shift, by route pattern',
  bounds: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2],
});

export interface ClientVitalsRouteOptions {
  readonly pages?: () => readonly ClientErrorPage[];
}

/** The most specific page on a listed surface the path names — its PATTERN, else nothing. */
function patternOf(
  pages: readonly ClientErrorPage[],
  surfaces: readonly ClientVitalsSurface[],
  path: string,
): string | undefined {
  let best: ClientErrorPage | undefined;
  for (const page of pages) {
    if (!surfaces.some((surface) => surface === page.surface)) continue;
    if (!page.pattern.regex.test(path)) continue;
    if (best === undefined || page.pattern.specificity > best.pattern.specificity) best = page;
  }
  return best?.path;
}

/** Same-origin evidence, or the beacon is dropped: a cross-site page must not skew the numbers. */
function sameOrigin(request: UltimateRequest, ctx: RequestContext): boolean {
  return proveSameOrigin({
    selfOrigins: [selfOrigin(ctx.url, ctx.https)],
    origin: request.header('origin'),
    secFetchSite: request.header('sec-fetch-site') || null,
    listed: () => false,
    listName: "the app's own origin",
  }).ok;
}

/** The beacon's `{ path, vitals }`, or `undefined` — never a reason: a probe learns nothing. */
async function beaconOf(request: UltimateRequest) {
  const read = await readWithinLimit(request.raw.body, CLIENT_VITALS_MAX_BODY_BYTES);
  if ('over' in read) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return undefined;
  }
  if (!isJsonObject(body) || typeof body['path'] !== 'string') return undefined;
  const vitals = body['vitals'];
  if (!isJsonObject(vitals) || !PATH.test(body['path'])) return undefined;
  return { path: body['path'], vitals };
}

/** Records every known, in-range timing; drops the rest one by one. */
function record(route: string, vitals: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(vitals)) {
    if (!isVitalName(name) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < 0) continue;
    if (name === 'cls') {
      if (value <= MAX_CLS) shift.record(value, { route });
    } else if (value <= MAX_MS) {
      seconds.record(value / 1000, { route, metric: name });
    }
  }
}

export function clientVitalsRoutes(
  config: ClientVitalsConfig,
  options: ClientVitalsRouteOptions = {},
): readonly Route[] {
  const pages = options.pages ?? routeEntries;
  const source = clientVitalsScript(config.sampleRate);
  const answered = (): Response => new Response(null, { status: 204 });
  return [
    {
      method: 'GET',
      path: CLIENT_VITALS_SCRIPT_PATH,
      meta: { name: 'clientVitals.script', auth: 'public' },
      // Revalidated, as `/x-client-errors.js` is: a changed rate reaches a returning tab.
      handler: (request) => revalidatedResponse(request, source, 'text/javascript; charset=utf-8'),
    },
    {
      method: 'POST',
      path: CLIENT_VITALS_PATH,
      meta: {
        name: 'clientVitals.beacon',
        // Anonymous by design: a timing names no one, so no sign-in stands in front of it.
        auth: 'public',
        cache: NO_STORE,
        // Per address, on the app's own rate-limit store — the stage `/_client-errors` uses.
        rateLimit: 'clientVitals.beacon',
        rateLimitBucket: {
          capacity: CLIENT_VITALS_PER_MINUTE,
          refillPerSecond: CLIENT_VITALS_PER_MINUTE / 60,
        },
      },
      // Every outcome is the same 204: a refusal that said why would teach a probe the shape.
      handler: async (request, ctx) => {
        if (!sameOrigin(request, ctx)) return answered();
        const beacon = await beaconOf(request);
        if (beacon === undefined) return answered();
        const route = patternOf(pages(), config.surfaces, beacon.path);
        if (route !== undefined) record(route, beacon.vitals);
        return answered();
      },
    },
  ];
}

export interface ClientVitalsSurfaceMount {
  readonly routes: readonly Route[];
  /** For `DocumentOptions.appHead`, `''` when `app` is not listed. */
  readonly appHead: string;
  /** For the `site/` document head, `''` unless `site` is listed — the static path opts in. */
  readonly siteHead: string;
}

/** What a boot mounts for `clientErrors.vitals`: nothing at all unless enabled. */
export function clientVitalsSurface(
  config: ClientVitalsConfig | undefined,
  options: ClientVitalsRouteOptions = {},
): ClientVitalsSurfaceMount | undefined {
  if (config?.enabled !== true) return undefined;
  const head = (surface: ClientVitalsSurface): string =>
    config.surfaces.includes(surface) ? clientVitalsHead() : '';
  return {
    routes: clientVitalsRoutes(config, options),
    appHead: head('app'),
    siteHead: head('site'),
  };
}

/**
 * The document heads the browser scripts compose into — for `DocumentOptions`, spread. The one
 * place `x dev` and the container combine them, so the two cannot name different scripts. A key
 * is absent rather than `''` when nothing rides it. `zone` (`time.detect`, `zone-boot.ts`) is an
 * `app/` tag only: a `site/` page is a file, and a file cannot answer in the visitor's zone.
 */
export function clientScriptHeads(
  errors: { readonly head: string } | undefined,
  vitals: ClientVitalsSurfaceMount | undefined,
  zone?: { readonly head: string } | undefined,
): { readonly appHead?: string; readonly siteHead?: string } {
  const appHead = (zone?.head ?? '') + (errors?.head ?? '') + (vitals?.appHead ?? '');
  const siteHead = vitals?.siteHead ?? '';
  return {
    ...(appHead === '' ? {} : { appHead }),
    ...(siteHead === '' ? {} : { siteHead }),
  };
}
