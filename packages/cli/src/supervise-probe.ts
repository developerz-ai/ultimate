// The supervised container's `METRICS_PORT`: `/healthz` (the supervisor is alive and not in a
// crash loop), `/readyz` (every child that is not draining said ready), and `/metrics` — each
// child's loopback scrape, merged under one HELP/TYPE per family with a `child="<i>"` label.

import { METRICS_CONTENT_TYPE, METRICS_PATH, markListening } from '@ultimat3/core';
import { bindScrapePort } from './metrics-endpoint';
import type { ChildView, SupervisorView } from './supervise';

/** One child's scrape may not hold the container's: a saturated child answers late (measured). */
export const CHILD_SCRAPE_TIMEOUT_MS = 2_000;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const COMMENT = /^#\s+(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\s|$)/;

/** `name{a="1"} 2` → `name{child="i",a="1"} 2`; `name 2` → `name{child="i"} 2`. */
export function labelSample(line: string, index: number): string {
  const name = METRIC_NAME.exec(line)?.[0];
  if (name === undefined) return line;
  const label = `child="${String(index)}"`;
  const rest = line.slice(name.length);
  if (!rest.startsWith('{')) return `${name}{${label}}${rest}`;
  return `${name}{${label}${rest.startsWith('{}') ? '' : ','}${rest.slice(1)}`;
}

interface Family {
  help: string | undefined;
  type: string | undefined;
  readonly samples: string[];
}

/**
 * Every child's exposition as one: a family's HELP and TYPE once (the first child's), then its
 * samples from every child in child order. A sample belongs to the family the comment above it
 * named — a histogram's `_bucket`, `_sum` and `_count` stay under their family.
 */
export function mergeMetrics(
  bodies: readonly { readonly index: number; readonly body: string }[],
): string {
  const families = new Map<string, Family>();
  const familyOf = (name: string): Family => {
    let family = families.get(name);
    if (family === undefined) {
      family = { help: undefined, type: undefined, samples: [] };
      families.set(name, family);
    }
    return family;
  };
  for (const { index, body } of bodies) {
    let current: string | undefined;
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      const comment = COMMENT.exec(line);
      if (comment !== null) {
        const [, kind, name = ''] = comment;
        current = name;
        const family = familyOf(name);
        if (kind === 'HELP') family.help ??= line;
        else family.type ??= line;
        continue;
      }
      if (line.startsWith('#')) continue;
      const name = METRIC_NAME.exec(line)?.[0];
      if (name === undefined) continue;
      const owner = current !== undefined && name.startsWith(current) ? current : name;
      familyOf(owner).samples.push(labelSample(line, index));
    }
  }
  const out: string[] = [];
  for (const family of families.values()) {
    if (family.help !== undefined) out.push(family.help);
    if (family.type !== undefined) out.push(family.type);
    out.push(...family.samples);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Whether a child's loopback `/healthz` answers 200 in time. */
export async function childHealthy(metricsUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${metricsUrl}/healthz`, {
      signal: AbortSignal.timeout(CHILD_SCRAPE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function scrape(child: ChildView): Promise<{ index: number; body: string } | undefined> {
  if (child.metricsUrl === undefined) return undefined;
  try {
    const response = await fetch(`${child.metricsUrl}${METRICS_PATH}`, {
      signal: AbortSignal.timeout(CHILD_SCRAPE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Given back now, as `childHealthy` does: unread, the stream and its socket stay held.
      await response.body?.cancel();
      return undefined;
    }
    return { index: child.index, body: await response.text() };
  } catch {
    // A child that is restarting or saturated is absent from this scrape, never the scrape's end.
    return undefined;
  }
}

export interface SupervisorProbeInput {
  readonly port: number;
  readonly hostname: string;
  readonly role: string;
  readonly view: SupervisorView;
}

export interface SupervisorProbe {
  readonly url: string;
  stop(): void;
}

const verdict = (ok: boolean, state: string, role: string): Response =>
  Response.json(
    { state, ready: ok, role },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );

/** Opened before the first child spawns, so the platform's probes reach a socket from the start. */
export function startSupervisorProbe(input: SupervisorProbeInput): SupervisorProbe {
  const server = bindScrapePort(input.port, 'refuse', (port) =>
    Bun.serve({
      port,
      hostname: input.hostname,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === '/healthz') {
          const live = input.view.live();
          return verdict(live, live ? 'live' : 'crash-loop', input.role);
        }
        if (path === '/readyz') {
          const ready = input.view.ready();
          return verdict(ready, ready ? 'ready' : 'not-ready', input.role);
        }
        if (path !== METRICS_PATH) return new Response('not found', { status: 404 });
        const bodies = await Promise.all(input.view.children().map(scrape));
        return new Response(mergeMetrics(bodies.filter((body) => body !== undefined)), {
          headers: { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' },
        });
      },
    }),
  );
  const stopListening = markListening(server.url.origin);
  return {
    url: server.url.origin,
    stop(): void {
      server.stop(true);
      stopListening();
    },
  };
}
