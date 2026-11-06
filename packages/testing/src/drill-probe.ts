// One status probe and a sampler over it: how a drill asks a role's `/readyz` what it says while a
// dependency fails. Through `node:http`, never `fetch`, so the probe answers the same inside
// `bun test` — where the preload seals `fetch` — as under `x drill`.

// why: `globalThis.fetch` is sealed inside `bun test`; `node:http` is not, and loopback is all it reaches.
import { get } from 'node:http';
import { finiteCount } from '@ultimat3/core';

/** One GET: the status, or `null` when nothing answered within `boundMs`. Never a throw. */
export function probeStatus(url: string, boundMs: number): Promise<number | null> {
  const bound = finiteCount('probeStatus', 'boundMs', boundMs, 1);
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? null);
    });
    request.on('error', () => resolve(null));
    request.setTimeout(bound, () => {
      request.destroy();
      resolve(null);
    });
  });
}

export interface StatusSample {
  /** ms since the sampler's `zero`. */
  readonly atMs: number;
  readonly status: number | null;
}

export interface StatusSampler {
  stop(): Promise<readonly StatusSample[]>;
}

export interface StatusSamplerOptions {
  readonly url: string;
  readonly everyMs: number;
  readonly boundMs: number;
  /** The instant `atMs` counts from — the fault's start. */
  readonly zero: number;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly probe?: ((url: string, boundMs: number) => Promise<number | null>) | undefined;
}

/** Probe `url` every `everyMs` until `stop()`; one probe at a time, so a hung one is one sample. */
export function sampleStatus(options: StatusSamplerOptions): StatusSampler {
  const everyMs = finiteCount('sampleStatus', 'everyMs', options.everyMs, 1);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const probe = options.probe ?? probeStatus;
  const samples: StatusSample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const atMs = Math.round(now() - options.zero);
      samples.push({ atMs, status: await probe(options.url, options.boundMs) });
      if (!stopped) await sleep(everyMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return samples;
    },
  };
}
