import { describe, expect, test } from 'bun:test';
import type { StreamPlan } from './render-stream';
import {
  collectStream,
  DEFAULT_HOLE_TIMEOUT_MS,
  holeMarker,
  REVEAL_SCRIPT,
  renderStreamHtml,
  revealChunk,
} from './render-stream';

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

describe('a client that disconnects mid-stream', () => {
  /** Three holes, none of which resolves until the test says so. */
  function threeHoles(): {
    plan: StreamPlan;
    signals: AbortSignal[];
    settle: (id: string, html: string) => void;
  } {
    const gates = new Map<string, (value: string) => void>();
    const signals: AbortSignal[] = [];
    const hole = (id: string) => ({
      id,
      fallback: '<i>…</i>',
      resolve: (signal: AbortSignal): Promise<string> => {
        signals.push(signal);
        return new Promise<string>((res) => gates.set(id, res));
      },
    });
    return {
      plan: {
        head: '<!doctype html><html><head></head><body>',
        shell: `${holeMarker('a', '')}${holeMarker('b', '')}${holeMarker('c', '')}`,
        holes: [hole('a'), hole('b'), hole('c')],
      },
      signals,
      settle: (id, html) => gates.get(id)?.(html),
    };
  }

  // The measured failure: `settle()` ran `write(tail)` and `controller.close()` on a cancelled
  // controller, throwing out of the final `.then(settle, settle)` whose promise is `void`ed —
  // one unhandled rejection per response. Bun's test runner fails this file on one.
  test('a hole resolving after the cancel enqueues nothing and throws nothing', async () => {
    const { plan, settle } = threeHoles();
    const stream = renderStreamHtml(plan, { buildId: 'b1' });
    const reader = stream.getReader();
    await reader.read(); // the shell

    await reader.cancel('client gone');

    settle('a', '<b>a</b>');
    settle('b', '<b>b</b>');
    settle('c', '<b>c</b>');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Meanwhile the resolved holes kept doing their database work with nowhere to write it.
  test('aborts every hole still running', async () => {
    const { plan, signals } = threeHoles();
    const stream = renderStreamHtml(plan, { buildId: 'b1' });
    const reader = stream.getReader();
    await reader.read();

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(false);

    await reader.cancel('client gone');

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test('a live stream leaves the holes un-aborted', async () => {
    const { plan, signals, settle } = threeHoles();
    const stream = renderStreamHtml(plan, { buildId: 'b1' });
    settle('a', '<b>a</b>');
    settle('b', '<b>b</b>');
    settle('c', '<b>c</b>');

    expect(await collectStream(stream)).toContain('</body></html>');
    expect(signals.some((signal) => signal.aborted)).toBe(false);
  });
});

// A hole is `await`ed application code — a query with no statement timeout, a fetch with no
// `AbortSignal.timeout`. Nothing outside this file bounded one: `settle` fired only from the
// hole's own promise, so a hole that never settled held the response, the socket and everything
// the closure retained open for as long as the process ran.
describe('a hole that never settles', () => {
  test('misses its deadline and degrades to the error fallback', async () => {
    const never = new Promise<string>(() => undefined);
    const plan: StreamPlan = {
      head: '<!doctype html><html><head></head><body>',
      shell: holeMarker('feed', '<div>skeleton</div>'),
      holes: [{ id: 'feed', fallback: '<div>skeleton</div>', resolve: () => never }],
    };

    const html = await collectStream(renderStreamHtml(plan, { buildId: 'b1', holeTimeoutMs: 10 }));

    expect(html).toContain('data-x-hole-error="feed"');
    expect(html).toContain('</body></html>');
  });

  test('a hole that resolves AFTER its deadline enqueues nothing twice', async () => {
    const late = deferred();
    const plan: StreamPlan = {
      head: '<head>',
      shell: holeMarker('feed', '<div>skeleton</div>'),
      holes: [{ id: 'feed', fallback: '<div>skeleton</div>', resolve: () => late.promise }],
    };

    const html = await collectStream(renderStreamHtml(plan, { buildId: 'b1', holeTimeoutMs: 10 }));
    late.resolve('<ul>too late</ul>');
    await late.promise;

    expect(html).not.toContain('too late');
    expect(html.split('</body></html>').length - 1).toBe(1);
  });

  test('holeTimeoutMs: null is the opt-out, and the hole still decides', async () => {
    const slow = deferred();
    const plan: StreamPlan = {
      head: '<head>',
      shell: holeMarker('feed', '<div>skeleton</div>'),
      holes: [{ id: 'feed', fallback: '<div>skeleton</div>', resolve: () => slow.promise }],
    };

    const collected = collectStream(renderStreamHtml(plan, { buildId: 'b1', holeTimeoutMs: null }));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    slow.resolve('<ul>worth waiting for</ul>');

    expect(await collected).toContain('worth waiting for');
  });

  test('the default deadline is declared, not implicit', () => {
    expect(DEFAULT_HOLE_TIMEOUT_MS).toBe(15_000);
  });
});

/**
 * Both are public exports that build an attribute AND a `<script>` body out of a hole id. Author-
 * controlled today — the same status `emitIslandAttributes` had until a sweep found it raw. A `")`
 * in the id closes the `$X(` call and everything after it is executable on the page's own origin.
 */
describe('a hole id that would break out', () => {
  test('the marker attribute is escaped, so the quote cannot close it', () => {
    const marker = holeMarker('a" onload="alert(1)', 'fallback');
    expect(marker).not.toContain('onload="alert(1)"');
    expect(marker).toContain('&quot;');
  });

  test('the reveal template attribute is escaped too', () => {
    const chunk = revealChunk('a" data-evil="1', '<p>x</p>');
    expect(chunk).not.toContain('data-evil="1"');
    expect(chunk).toContain('&quot;');
  });

  test('the script argument is a JS string literal, never raw interpolation', () => {
    const chunk = revealChunk('a");alert(1);//', '<p>x</p>');
    expect(chunk).not.toContain('$X("x:a");alert(1);//")');
    expect(chunk).toContain('alert(1);//');
    expect(chunk).toContain(String.raw`$X("x:a\");alert(1);//")`);
  });

  test('a closing tag inside the id cannot end the script element', () => {
    const chunk = revealChunk('a</script><script>alert(1)</script', '<p>x</p>');
    expect(chunk).not.toContain('</script><script>alert(1)');
  });

  test('an ordinary id still round-trips between the marker and the reveal', () => {
    expect(holeMarker('feed', 'f')).toBe('<x-hole id="x:feed">f</x-hole>');
    expect(revealChunk('feed', '<p>x</p>')).toBe(
      '<template data-x-hole="x:feed"><p>x</p></template><script>$X("x:feed")</script>',
    );
  });
});

/**
 * A hole is application code, and a rejection VALUE is whatever it threw. The rejection handler
 * rendered it with `error instanceof Error ? error.message : String(error)` — which raises on a
 * null-prototype object, inside the handler whose next line reveals the fallback. The hole then
 * never revealed at all, and the response held open until its deadline.
 */
describe('a hole that rejects with a value String() cannot render', () => {
  test('still reveals the error fallback', async () => {
    const plan: StreamPlan = {
      head: '<html><body>',
      shell: holeMarker('feed', '<div>skeleton</div>'),
      holes: [
        {
          id: 'feed',
          fallback: '<div>skeleton</div>',
          resolve: () => Promise.reject(Object.create(null)),
        },
      ],
    };
    const html = await collectStream(renderStreamHtml(plan, { buildId: 'b1' }));
    expect(html).toContain('data-x-hole="x:feed"');
    expect(html).toContain('$X("x:feed")');
  });
});
