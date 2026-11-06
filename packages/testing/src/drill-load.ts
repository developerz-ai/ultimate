// A drill's load: lanes of requests against the web role, every answer recorded with its timing
// and its `X_*` code, then folded into the evidence the verdict reads. Each POST carries its own
// idempotency key, so a retried write is the framework's to dedupe and a doubled one is a finding.

import { finiteCount } from '@ultimat3/core';
import type { DrillRequestEvidence } from './drill-verdict';

export interface DrillTarget {
  readonly method: 'GET' | 'POST';
  /** Path from the web role's origin, query included. */
  readonly path: string;
  /** A POST's JSON body. */
  readonly body?: unknown;
  /**
   * A POST's body per request, given the load's request number (from 1); wins over `body`. A write
   * that enqueues a job needs a distinct input each time, or its key dedupes every request into one.
   */
  readonly draw?: ((run: number) => unknown) | undefined;
}

/** One request, as the load saw it. Times are ms on the load's own monotonic clock. */
export interface DrillSample {
  readonly target: string;
  readonly startedMs: number;
  readonly endedMs: number;
  /** `null`: nothing answered — refused, reset, or past the harness's own bound. */
  readonly status: number | null;
  /** The problem document's `code`, when the answer carried one. */
  readonly code: string | undefined;
}

export interface DrillLoadOptions {
  readonly base: string;
  readonly targets: readonly DrillTarget[];
  readonly lanes?: number | undefined;
  /** The harness's own bound on one request: past it the request is `unanswered`. */
  readonly requestBoundMs: number;
  /** Between two requests of one lane, so a lane measures rather than floods. */
  readonly pauseMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DrillLoad {
  /** Every sample so far, in completion order. */
  samples(): readonly DrillSample[];
  /** Stop every lane and wait for its in-flight request to settle. */
  stop(): Promise<readonly DrillSample[]>;
}

const CODE = /^X_[A-Z0-9_]+$/;

/** The `code` of a problem document, or `undefined` for any other body. */
export function problemCode(contentType: string | null, body: string): string | undefined {
  if (contentType === null || !contentType.includes('json')) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const code =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'code') : undefined;
    return typeof code === 'string' && CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const bodyOf = (target: DrillTarget, run: number): unknown =>
  target.draw === undefined ? (target.body ?? {}) : target.draw(run);

/** Lanes over `targets`, round-robin, until `stop()`. */
export function startDrillLoad(options: DrillLoadOptions): DrillLoad {
  const lanes = finiteCount('startDrillLoad', 'lanes', options.lanes ?? 4, 1);
  const pauseMs = finiteCount('startDrillLoad', 'pauseMs', options.pauseMs ?? 50);
  const boundMs = finiteCount('startDrillLoad', 'requestBoundMs', options.requestBoundMs, 1);
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const samples: DrillSample[] = [];
  const stopping = new AbortController();
  let sequence = 0;

  const once = async (target: DrillTarget): Promise<void> => {
    sequence += 1;
    const run = sequence;
    const label = `${target.method} ${target.path}`;
    const headers: Record<string, string> = {
      'x-forwarded-for': `10.${String((sequence >> 16) & 255)}.${String((sequence >> 8) & 255)}.${String(sequence & 255)}`,
    };
    if (target.method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = `drill-${String(sequence)}`;
    }
    const startedMs = now();
    try {
      const response = await send(`${options.base}${target.path}`, {
        method: target.method,
        headers,
        ...(target.method === 'POST' ? { body: JSON.stringify(bodyOf(target, run)) } : {}),
        signal: AbortSignal.timeout(boundMs),
      });
      const body = await response.text();
      samples.push({
        target: label,
        startedMs,
        endedMs: now(),
        status: response.status,
        code: problemCode(response.headers.get('content-type'), body),
      });
    } catch {
      samples.push({ target: label, startedMs, endedMs: now(), status: null, code: undefined });
    }
  };

  const lane = async (index: number): Promise<void> => {
    for (let turn = index; !stopping.signal.aborted; turn += 1) {
      const target = options.targets[turn % options.targets.length];
      if (target === undefined) return;
      await once(target);
      if (!stopping.signal.aborted) await sleep(pauseMs);
    }
  };

  const running = Array.from({ length: lanes }, (_, index) => lane(index));
  return {
    samples: () => samples,
    async stop() {
      stopping.abort();
      await Promise.all(running);
      return samples;
    },
  };
}

/** `X_INTERNAL` is the code of a throw nothing classified: a failure, but not a coded one. */
const UNCLASSIFIED = 'X_INTERNAL';

/** The samples as the verdict reads them. */
export function requestEvidence(samples: readonly DrillSample[]): DrillRequestEvidence {
  const failedByCode = new Map<string, number>();
  let ok = 0;
  let uncoded = 0;
  let unanswered = 0;
  let maxMs = 0;
  for (const sample of samples) {
    if (sample.status === null) {
      unanswered += 1;
      continue;
    }
    maxMs = Math.max(maxMs, Math.round(sample.endedMs - sample.startedMs));
    if (sample.status >= 200 && sample.status < 300) ok += 1;
    else if (sample.code === undefined || sample.code === UNCLASSIFIED) uncoded += 1;
    else failedByCode.set(sample.code, (failedByCode.get(sample.code) ?? 0) + 1);
  }
  return { ok, failedByCode, uncoded, unanswered, maxMs };
}

/** ms from `clearedMs` to the end of the first 2xx that STARTED after it; `null` for none. */
export function recoveryAfter(samples: readonly DrillSample[], clearedMs: number): number | null {
  let first: number | null = null;
  for (const sample of samples) {
    const answered = sample.status !== null && sample.status >= 200 && sample.status < 300;
    if (!answered || sample.startedMs < clearedMs) continue;
    if (first === null || sample.endedMs < first) first = sample.endedMs;
  }
  return first === null ? null : Math.round(first - clearedMs);
}
