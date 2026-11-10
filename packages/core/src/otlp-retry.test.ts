// A collector restart must not remove spans: a 429, 502, 503, 504 or a transport failure is sent
// again on core's one retry loop, inside the export's one time budget, with one log line per batch
// whatever the attempt count, and `postOtlp` never rejects on any of these paths.

import { afterEach, describe, expect, test } from 'bun:test';
import { installLogSink, type LogLevel } from './logger';
import { OTLP_RETRY_STATUSES, type OtlpPostOptions, postOtlp } from './otlp-post';
import { otlpSpanExporter } from './otlp-span-exporter';
import type { ReadableSpan } from './telemetry';

interface Line {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function capture(): Line[] {
  const lines: Line[] = [];
  const releaseLogSink = installLogSink((line, level) => {
    const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
    lines.push({ level, msg, fields });
  });
  restore = () => releaseLogSink();
  return lines;
}

type Answer = number | { readonly status: number; readonly headers: Record<string, string> };

/** A collector that answers from a script, the last answer repeating, and records every body. */
function scriptedCollector(answers: readonly (Answer | 'throw')[]) {
  const bodies: string[] = [];
  const fetch = Object.assign(
    (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const answer = answers[Math.min(bodies.length, answers.length - 1)] ?? 200;
      bodies.push(String(init?.body ?? ''));
      if (answer === 'throw') return Promise.reject(new TypeError('ECONNRESET'));
      const { status, headers } =
        typeof answer === 'number' ? { status: answer, headers: {} } : answer;
      return Promise.resolve(new Response('', { status, headers }));
    },
    { preconnect: (): void => {} },
  ) as typeof globalThis.fetch;
  return { fetch, bodies };
}

/** An injected wait and clock: a wait advances the clock by exactly what it was asked. */
function fakeTime() {
  let at = 0;
  const waits: number[] = [];
  return {
    waits,
    now: (): number => at,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      at += ms;
      return Promise.resolve();
    },
    advance: (ms: number): void => {
      at += ms;
    },
  };
}

const post = (
  fetch: typeof globalThis.fetch,
  time: ReturnType<typeof fakeTime>,
  extra: Partial<OtlpPostOptions> = {},
): Promise<void> =>
  postOtlp({
    url: 'http://collector:4318/v1/traces',
    headers: {},
    body: '{"batch":1}',
    timeoutMs: 10_000,
    fetch,
    sleep: time.sleep,
    now: time.now,
    random: () => 0.5,
    ...extra,
  });

const span = (index: number): ReadableSpan => ({
  name: `span-${index}`,
  kind: 'internal',
  context: {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: 1,
  },
  parentSpanId: undefined,
  startedAt: 1_767_225_600_000,
  endedAt: 1_767_225_600_001,
  durationMs: 1,
  attributes: {},
  events: [],
  droppedEventsCount: 0,
  status: { code: 'ok' },
  links: [],
  resource: { serviceName: 'web', serviceVersion: '1.2.0' },
});

const spansIn = (body: string): number =>
  (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }).resourceSpans[0]
    ?.scopeSpans[0]?.spans.length ?? 0;

describe('postOtlp · a transient answer is sent again', () => {
  test('the statuses are the OTLP/HTTP specification list, not core’s wider table', () => {
    expect([...OTLP_RETRY_STATUSES].sort()).toEqual([429, 502, 503, 504]);
  });

  test('the probe: maxBatchSize 2, the first POST answers 503, 4 spans — 4 of 4 delivered', async () => {
    const collector = scriptedCollector([503, 200]);
    const time = fakeTime();
    const exporter = otlpSpanExporter({
      endpoint: 'http://collector:4318/v1/traces',
      maxBatchSize: 2,
      fetch: collector.fetch,
      sleep: time.sleep,
      now: time.now,
      random: () => 0,
    });
    for (let index = 0; index < 4; index += 1) exporter.export(span(index));
    await exporter.shutdown();
    expect(collector.bodies).toHaveLength(3);
    const delivered = collector.bodies.slice(1).reduce((sum, body) => sum + spansIn(body), 0);
    expect(delivered).toBe(4);
    // Order holds across the retry: the batch that failed is the one that goes next.
    expect(collector.bodies[1]).toBe(collector.bodies[0] as string);
  });

  test('503, 503, 200 is three posts and no warn line', async () => {
    const lines = capture();
    const collector = scriptedCollector([503, 503, 200]);
    const time = fakeTime();
    await post(collector.fetch, time);
    expect(collector.bodies).toHaveLength(3);
    expect(time.waits).toHaveLength(2);
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  test.each([429, 502, 504])('%d is retried', async (status) => {
    const collector = scriptedCollector([status, 200]);
    await post(collector.fetch, fakeTime());
    expect(collector.bodies).toHaveLength(2);
  });

  test.each([400, 500, 401, 404])('%d is one post and one rejected line', async (status) => {
    const lines = capture();
    const collector = scriptedCollector([status]);
    await post(collector.fetch, fakeTime());
    expect(collector.bodies).toHaveLength(1);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export rejected']);
    expect(lines[0]?.fields).toMatchObject({ status, attempts: 1 });
  });

  test('three 503s exhaust the attempts with ONE line naming the count', async () => {
    const lines = capture();
    const collector = scriptedCollector([503]);
    await post(collector.fetch, fakeTime());
    expect(collector.bodies).toHaveLength(3);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export rejected']);
    expect(lines[0]?.fields).toMatchObject({ status: 503, attempts: 3 });
  });

  test('a Retry-After: 2 waits 2 s by the injected sleep', async () => {
    const collector = scriptedCollector([{ status: 503, headers: { 'retry-after': '2' } }, 200]);
    const time = fakeTime();
    await post(collector.fetch, time, { random: () => 0 });
    expect(time.waits).toEqual([2_000]);
    expect(collector.bodies).toHaveLength(2);
  });

  test('a throwing fetch is retried, and its last failure is one failed line', async () => {
    const lines = capture();
    const recovering = scriptedCollector(['throw', 200]);
    await post(recovering.fetch, fakeTime());
    expect(recovering.bodies).toHaveLength(2);
    expect(lines).toEqual([]);

    const down = scriptedCollector(['throw']);
    await post(down.fetch, fakeTime());
    expect(down.bodies).toHaveLength(3);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export failed']);
    expect(lines[0]?.fields).toMatchObject({ attempts: 3 });
    expect(String(lines[0]?.fields['error'])).toContain('ECONNRESET');
  });
});

describe('postOtlp · timeoutMs is the whole export', () => {
  test('a wait that would end past the budget is never started: one line, early stop', async () => {
    const lines = capture();
    const collector = scriptedCollector([{ status: 503, headers: { 'retry-after': '5' } }]);
    const time = fakeTime();
    await post(collector.fetch, time, { timeoutMs: 3_000, random: () => 0 });
    expect(collector.bodies).toHaveLength(1);
    expect(time.waits).toEqual([]);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export rejected']);
    expect(lines[0]?.fields).toMatchObject({ status: 503, attempts: 1 });
  });

  test('time spent in a slow answer counts against the budget', async () => {
    const time = fakeTime();
    const collector = scriptedCollector([503]);
    const slow = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      time.advance(9_900);
      return collector.fetch(url, init);
    }) as typeof globalThis.fetch;
    await post(slow, time, { random: () => 1 });
    expect(collector.bodies).toHaveLength(1);
  });

  test('each attempt is handed a signal for what remains, and its own abort is not retried', async () => {
    const lines = capture();
    const time = fakeTime();
    let calls = 0;
    const hung = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    // `random: 0` makes every backoff 0 ms, so only the abort check can stop a second attempt.
    await post(hung, time, { timeoutMs: 20, random: () => 0 });
    expect(calls).toBe(1);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export failed']);
    expect(lines[0]?.fields).toMatchObject({ attempts: 1 });
  });

  test('a later attempt gets only what is left, never a fresh timeoutMs', async () => {
    const lines = capture();
    const time = fakeTime();
    let calls = 0;
    // The first answer spends all but 15 ms of the budget; the second hangs until its signal
    // fires. A fresh 10 s signal would hold this test past its own timeout.
    const spending = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        time.advance(9_985);
        return Promise.resolve(new Response('', { status: 503 }));
      }
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    await post(spending, time, { random: () => 0 });
    expect(calls).toBe(2);
    expect(lines.map((line) => line.msg)).toEqual(['otlp export failed']);
    expect(lines[0]?.fields).toMatchObject({ attempts: 2 });
  });
});

describe('postOtlp · the wait between attempts holds the process', () => {
  test('a shutdown flush answered 503 is sent again before the process exits', async () => {
    // A child with nothing else on its event loop: the retry's own timer is all that keeps it
    // alive. An unref'd wait let it exit 0 mid-wait, the batch lost and no line printed.
    const module = JSON.stringify(import.meta.resolve('./otlp-post.ts'));
    const child = `
      import { postOtlp } from ${module};
      let posts = 0;
      const fetch = async () => new Response('', { status: ++posts === 1 ? 503 : 200 });
      // Not awaited at the top level, as a drain hook's flush is not: a pending top-level await
      // would keep the child alive by itself and hide the timer under test.
      void postOtlp({ url: 'http://collector:4318/v1/traces', headers: {}, body: '{}',
        timeoutMs: 10_000, fetch, random: () => 0.2 }).then(() => console.log('posts ' + posts));
    `;
    const run = Bun.spawn(['bun', '-e', child], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    const [stdout, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('posts 2');
  });
});

describe('postOtlp · never rejects', () => {
  test.each<readonly (Answer | 'throw')[]>([[503], [400], ['throw'], [200]])(
    'under %p',
    async (...answers) => {
      capture();
      const collector = scriptedCollector(answers);
      await expect(post(collector.fetch, fakeTime())).resolves.toBeUndefined();
    },
  );

  test('a sleep that rejects still ends in a line', async () => {
    const lines = capture();
    const collector = scriptedCollector([503]);
    const time = fakeTime();
    await expect(
      post(collector.fetch, time, {
        sleep: () => Promise.reject(new TypeError('timer refused')),
      }),
    ).resolves.toBeUndefined();
    expect(lines.map((line) => line.msg)).toEqual(['otlp export failed']);
  });
});
