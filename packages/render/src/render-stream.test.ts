import { describe, expect, test } from 'bun:test';
import type { StreamPlan } from './render-stream';
import { collectStream, holeMarker, REVEAL_SCRIPT, renderStreamHtml } from './render-stream';

function deferred(): {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('out-of-order streaming', () => {
  test('the shell flushes before any hole resolves', async () => {
    const slow = deferred();
    const plan: StreamPlan = {
      head: '<!doctype html><html><head></head><body>',
      shell: `<header>Header</header>${holeMarker('stats', '<div>skeleton</div>')}`,
      holes: [{ id: 'stats', fallback: '<div>skeleton</div>', resolve: () => slow.promise }],
    };

    const stream = renderStreamHtml(plan, { buildId: 'b1' });
    const reader = stream.getReader();
    const first = await reader.read();
    const shell = new TextDecoder().decode(first.value);

    expect(shell).toContain('<header>Header</header>');
    expect(shell).toContain('<x-hole id="x:stats"><div>skeleton</div></x-hole>');
    expect(shell).toContain(REVEAL_SCRIPT);
    expect(shell).not.toContain('</body>');

    slow.resolve('<div>42</div>');
    reader.releaseLock();
    await collectStream(stream);
  });

  test('holes reveal in completion order, not declaration order', async () => {
    const fast = deferred();
    const slow = deferred();
    const plan: StreamPlan = {
      head: '<body>',
      shell: `${holeMarker('slow', 'a')}${holeMarker('fast', 'b')}`,
      holes: [
        { id: 'slow', fallback: 'a', resolve: () => slow.promise },
        { id: 'fast', fallback: 'b', resolve: () => fast.promise },
      ],
    };

    const stream = renderStreamHtml(plan, { buildId: 'b1' });
    const collected = collectStream(stream);

    fast.resolve('<i>fast</i>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    slow.resolve('<i>slow</i>');

    const html = await collected;
    expect(html.indexOf('data-x-hole="x:fast"')).toBeLessThan(html.indexOf('data-x-hole="x:slow"'));
    expect(html.endsWith('</body></html>')).toBe(true);
  });

  test('a rejected hole degrades to its fallback instead of truncating the document', async () => {
    const broken = deferred();
    const plan: StreamPlan = {
      head: '<body>',
      shell: holeMarker('feed', 'skeleton'),
      holes: [{ id: 'feed', fallback: 'skeleton', resolve: () => broken.promise }],
    };

    const stream = renderStreamHtml(plan, {
      buildId: 'b1',
      errorFallback: (id) => `<p data-err="${id}">unavailable</p>`,
    });
    const collected = collectStream(stream);
    broken.reject(new Error('query timed out'));

    const html = await collected;
    expect(html).toContain('<p data-err="feed">unavailable</p>');
    expect(html.endsWith('</body></html>')).toBe(true);
  });

  test('a plan with no holes still closes the document', async () => {
    const html = await collectStream(
      renderStreamHtml({ head: '<body>', shell: '<p>static</p>', holes: [] }, { buildId: 'b1' }),
    );
    expect(html).toBe('<body><p>static</p></body></html>');
  });
});
