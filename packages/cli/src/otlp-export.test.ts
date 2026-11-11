// `OTEL_EXPORTER_OTLP_ENDPOINT` is in the shipped Helm chart and nothing read it. The failure case
// is the one that shipped: a deployment configures a collector and the collector receives nothing.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import {
  drain,
  exportMetrics,
  installLogSink,
  logger,
  onShutdown,
  resetLifecycle,
  resetMetrics,
  resetTelemetry,
  shutdownHookCount,
  subscribed,
  subscriberCount,
  systemClock,
  withSpan,
} from '@ultimat3/core';
import { flushWithin, startOtlpExport } from './otlp-export';

let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
  resetTelemetry();
  resetMetrics();
});

describe('OTLP export is driven by the variable the chart already sets', () => {
  test('no endpoint installs nothing, and does not throw', () => {
    // Both exporters throw `X_OTLP_ENDPOINT_INVALID` at construction with no endpoint —
    // deliberately, so a telemetry exporter can never silently send nowhere. Asking
    // `tryOtlpEndpoint` first is what makes them optional without making them silent.
    const before = shutdownHookCount();
    release = startOtlpExport({});
    expect(shutdownHookCount()).toBe(before);
  });

  test('the generic endpoint installs all three signals behind ONE drain hook', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
    // `phase: 'close'`: the last spans of a drain are the ones that explain the drain. One hook,
    // flushing all three in parallel, so a black-holed collector cannot cost the drain 3 × 10 s.
    expect(shutdownHookCount()).toBe(before + 1);
    expect(subscribed('log.record')).toBe(true);
    expect(subscribed('span.end')).toBe(true);
  });

  test('a logs endpoint alone installs the logs exporter as a log.record subscriber', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector:4318/v1/logs',
    });
    expect(shutdownHookCount()).toBe(before + 1);
    expect(subscribed('log.record')).toBe(true);
    expect(subscribed('span.end')).toBe(false);
  });

  test('OTEL_<SIGNAL>_EXPORTER=none switches that one signal off — the OpenTelemetry spelling', () => {
    // A collector with no logs pipeline answers 404 to every batch; the generic endpoint now names
    // logs too, so the standard opt-out has to be honoured, per signal.
    const before = shutdownHookCount();
    release = startOtlpExport({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_LOGS_EXPORTER: ' NONE ',
    });
    expect(shutdownHookCount()).toBe(before + 1);
    expect(subscribed('log.record')).toBe(false);
    expect(subscribed('span.end')).toBe(true);
  });

  test('OTEL_SDK_DISABLED=true switches every signal off, the endpoint notwithstanding', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SDK_DISABLED: 'True',
    });
    expect(shutdownHookCount()).toBe(before);
    expect(subscribed('span.end')).toBe(false);
    expect(subscribed('log.record')).toBe(false);
  });

  test('the boot logs the endpoint without its query string', () => {
    const lines: string[] = [];
    const releaseLogSink = installLogSink((line) => lines.push(line));
    try {
      release = startOtlpExport({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318?api-key=s3cret',
      });
    } finally {
      releaseLogSink();
    }
    const boot = lines.filter((line) => line.includes('ultimate otlp'));
    expect(boot.length).toBeGreaterThan(0);
    expect(boot.join('')).not.toContain('s3cret');
    expect(boot.join('')).toContain('http://collector:4318/v1/traces');
  });

  test('the semconv histograms are subscribed on every boot, collector or not, and released', () => {
    // They feed `/metrics` as well as OTLP: a scrape-only deployment still gets them.
    const stop = startOtlpExport({});
    expect(subscribed('db.statement')).toBe(true);
    expect(subscribed('job.perform')).toBe(true);
    expect(subscribed('ai.llm')).toBe(true);
    stop();
    expect(subscribed('db.statement')).toBe(false);
  });

  test('a per-signal endpoint installs only that signal', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
    });
    expect(shutdownHookCount()).toBe(before + 1);
  });

  test('the release unregisters what it installed, so a second boot does not double up', () => {
    const before = shutdownHookCount();
    const subscriptions = subscriberCount();
    startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })();
    expect(shutdownHookCount()).toBe(before);
    expect(subscriberCount()).toBe(subscriptions);
  });

  test('the env is the BOOT’s, never `process.env` — `runRole({ env })` is a real seam', () => {
    // An in-process host and a test both pass an env that is not the process's, and an exporter
    // that re-read `process.env` would answer a different question from the one just asked. The
    // empty env is the assertion: if `process.env` were consulted, a machine with the variable
    // set would install exporters here.
    const before = shutdownHookCount();
    release = startOtlpExport({});
    expect(shutdownHookCount()).toBe(before);
  });

  test('a gRPC port is refused at boot rather than posting into a receiver that cannot read it', () => {
    // Not caught and downgraded: an endpoint an operator meant to work and that cannot is a boot
    // failure with a fix line, never a process that starts and exports nothing.
    expect(() => startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317' })).toThrow(
      /X_OTLP_PROTOCOL_UNSUPPORTED/,
    );
  });

  test('a span recorded after install still resolves through the configured exporter', async () => {
    release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
    // The point of `configureTelemetry({ exporter })`: without it every span this process opens is
    // handed to core's no-op and the collector's dashboard stays empty forever.
    await expect(withSpan('otlp.smoke', async () => 'ok')).resolves.toBe('ok');
  });
});

/**
 * `configureTelemetry` and `configureMetrics` write PROCESS-GLOBAL state, so a release that only
 * stops the timer and drops the drain hooks leaves the first boot's exporters installed — and a
 * second `serveApp` in the same process then exports into them. `cmd-dev.ts`'s `stop()` restores
 * `noopExporter` for exactly this reason and says so; this file did not.
 *
 * Both halves are observed through the exporter's own `fetch`, captured at construction: after the
 * release nothing this process records may reach the released collector.
 */
describe('the release uninstalls the exporters, not only their timers', () => {
  const captureFetch = (): { readonly urls: readonly string[]; restore: () => void } => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof globalThis.fetch;
    return {
      urls,
      restore: () => {
        globalThis.fetch = real;
      },
    };
  };

  test('a metric snapshot taken after the release reaches no collector', async () => {
    const posted = captureFetch();
    try {
      startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })();
      // The push tick `startMetricExport` drives. Its timer is stopped by the release; the
      // EXPORTER is what was left configured, and any later caller of one is enough to use it.
      exportMetrics();
      // Awaited: the POST is chained onto a settled promise, so a synchronous read of `urls` here
      // is empty whatever the exporter is — an assertion that cannot fail.
      await Bun.sleep(5);
      // The release SHUTS the log exporter down, so the boot's own lines queued before it are
      // delivered — that is the batch (c) keeps. Nothing reaches the metrics collector.
      expect(posted.urls.filter((url) => !url.endsWith('/v1/logs'))).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test('spans recorded after the release are not queued into the released exporter', async () => {
    const posted = captureFetch();
    try {
      startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })();
      // One batch's worth: the OTel default is 512 spans per POST, so the 512th is what makes a
      // still-installed exporter visible — it drains itself into the collector it was built for.
      for (let index = 0; index < 512; index += 1) {
        await withSpan(`otlp.after-release.${index}`, async () => undefined);
      }
      // The drain is chained through microtasks, so give it a turn before reading the calls.
      await Bun.sleep(5);
      expect(posted.urls.filter((url) => url.endsWith('/v1/traces'))).toEqual([]);
    } finally {
      posted.restore();
    }
  });
});

/**
 * The boot registers the exporter first, and `close` hooks run last-registered first, so the flush
 * is the last thing the drain does. Before that a worker's teardown span was recorded into an
 * exporter already shut down, and the window an operator went looking for was lost.
 */
describe('a span ended by a later close hook reaches the collector', () => {
  test('the flush runs after the teardown it is there to explain', async () => {
    resetLifecycle();
    const bodies: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
      onShutdown(
        'worker-teardown',
        async () => {
          await withSpan('span-from-worker-teardown', async () => 0);
        },
        { phase: 'close' },
      );
      await withSpan('span-before-drain', async () => 0);
      await drain('SIGTERM');
      const exported = bodies.join('');
      expect(exported).toContain('span-before-drain');
      expect(exported).toContain('span-from-worker-teardown');
    } finally {
      globalThis.fetch = real;
      resetLifecycle();
    }
  });
});

describe('process log lines reach the collector over OTLP', () => {
  test('a line logged after install is posted to /v1/logs by the drain', async () => {
    resetLifecycle();
    const posts: { url: string; body: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(input instanceof Request ? input.url : input),
        body: String(init?.body),
      });
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
      logger.warn('otlp.logs.smoke', { order: 'o-1' });
      await drain('SIGTERM');
      const logs = posts.filter((post) => post.url.endsWith('/v1/logs'));
      expect(logs.map((post) => post.body).join('')).toContain('otlp.logs.smoke');
    } finally {
      globalThis.fetch = real;
      resetLifecycle();
    }
  });
});

describe('the release ships what was queued before it', () => {
  test('a span ended before the release is posted, not dropped with the exporter', async () => {
    const bodies: string[] = [];
    // The release's shutdown is not awaited by its caller: wait for the POST itself, never a guess
    // at how long it takes. A dropped batch never posts, and the test times out naming it.
    const posted = Promise.withResolvers<void>();
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.join('').includes('span-before-release')) posted.resolve();
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const stop = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
      await withSpan('span-before-release', async () => 0);
      stop();
      await posted.promise;
      expect(bodies.join('')).toContain('span-before-release');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('the drain flush is bounded by the drain deadline', () => {
  test('a black-holed collector costs the drain its share of the deadline, never more', async () => {
    // Fake timers, not elapsed wall time: a loaded runner fires a real timer late, so a bound on
    // `performance.now()` deltas measured the machine (it flaked at 132 ms under the full gate).
    // What `flushWithin` DECIDES is the observable: the timer it arms is for the share of what is
    // left (0.8 × 100 ms = 80 ms), never more, and the drain returns when it fires although the
    // flushes never settle. 75/85 straddle 80 with room for the microseconds between the two
    // monotonic reads; the full deadline (100) or no cap at all leaves the drain pending at 85.
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    const lines: string[] = [];
    const releaseLogSink = installLogSink((line) => {
      lines.push(line);
    });
    jest.useFakeTimers();
    try {
      let returned = false;
      const flushed = flushWithin([hang, hang, hang], {
        deadlineAt: systemClock.monotonic() + 100,
      }).then(() => {
        returned = true;
      });
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(75);
      await settleMicrotasks();
      expect(returned).toBe(false);
      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      expect(returned).toBe(true);
      await flushed;
      expect(jest.getTimerCount()).toBe(0);
      expect(lines.join('\n')).toContain('otlp flush abandoned at the drain deadline');
    } finally {
      jest.useRealTimers();
      releaseLogSink();
    }
  });

  test('flushes run in parallel: all three are started before any of them settles', async () => {
    // Started is the observable, not elapsed time: a sequential run starts the second flush only
    // after the first settles, so it would hold one pending flush here, not three.
    const pending: (() => void)[] = [];
    const slow = (): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    const flushed = flushWithin([slow, slow, slow], {
      deadlineAt: systemClock.monotonic() + 5_000,
    });
    expect(pending).toHaveLength(3);
    for (const resolve of pending) resolve();
    await flushed;
  });
});

/** Drain the microtask queue a few hops deep — no timer, so fake timers cannot swallow the turn. */
async function settleMicrotasks(): Promise<void> {
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
}
