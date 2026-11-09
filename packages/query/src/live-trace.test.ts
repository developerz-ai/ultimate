// A live read joins the page's trace: the snapshot a subscribe asks for is a CHILD of the
// subscriber's `traceparent`, a re-run a change caused LINKS to it, and a garbage header is
// ignored — telemetry never fails a subscribe.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  memoryExporter,
  parseTraceparent,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
  withSpan,
} from '@ultimat3/core';
import { traceLiveRead } from './live-trace';

const PAGE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const page = parseTraceparent(PAGE);

afterEach(() => {
  resetTelemetry();
  resetInstrumentation();
});

async function spansOf(run: () => Promise<unknown>): Promise<readonly ReadableSpan[]> {
  const exporter = memoryExporter();
  subscribe('span.end', (event) => exporter.export(event.payload));
  await run();
  return exporter.spans;
}

describe('traceLiveRead', () => {
  test("the snapshot is a child of the subscriber's trace", async () => {
    const spans = await spansOf(() =>
      traceLiveRead('listPosts', 'snapshot', PAGE, async () => [1]),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('live.snapshot listPosts');
    expect(spans[0]?.context.traceId).toBe(page?.traceId ?? '');
    expect(spans[0]?.parentSpanId).toBe(page?.spanId ?? '');
    expect(spans[0]?.links).toEqual([]);
  });

  test('a re-run links to the subscriber and parents nothing on it', async () => {
    const spans = await spansOf(() => traceLiveRead('listPosts', 'rerun', PAGE, async () => []));
    expect(spans[0]?.name).toBe('live.rerun listPosts');
    expect(spans[0]?.context.traceId).not.toBe(page?.traceId);
    expect(spans[0]?.links).toEqual(page === undefined ? [] : [page]);
  });

  test('a re-run under the change that caused it is that change’s child', async () => {
    const spans = await spansOf(() =>
      withSpan('realtime.replicate', () =>
        traceLiveRead('listPosts', 'rerun', PAGE, async () => []),
      ),
    );
    const replicate = spans.find((span) => span.name === 'realtime.replicate');
    const rerun = spans.find((span) => span.name === 'live.rerun listPosts');
    expect(rerun?.parentSpanId).toBe(replicate?.context.spanId ?? '');
  });

  test('a garbage header starts a fresh trace, and the read still answers', async () => {
    let answered: readonly number[] = [];
    const spans = await spansOf(async () => {
      answered = await traceLiveRead('listPosts', 'snapshot', '00-zz-not-a-header', async () => [
        7,
      ]);
    });
    expect(answered).toEqual([7]);
    expect(spans[0]?.parentSpanId).toBeUndefined();
    expect(spans[0]?.context.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a read that rejects still rejects, with the span ended in error', async () => {
    const exporter = memoryExporter();
    subscribe('span.end', (event) => exporter.export(event.payload));
    const failed = traceLiveRead('listPosts', 'snapshot', undefined, () =>
      Promise.reject(new Error('read failed')),
    );
    await expect(failed).rejects.toThrow('read failed');
    expect(exporter.spans[0]?.status.code).toBe('error');
  });
});
