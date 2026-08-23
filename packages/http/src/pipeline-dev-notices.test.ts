// The one input the dev overlay cannot produce itself. The call COUNTS are what this file is for:
// a notice has exactly one surface, so a process that renders no overlay must never run the
// diagnostic that fills it — axiom 6 on the seam where it is cheapest to break, since a hook that
// reads a per-request ledger looks free right up until it ships to production.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import type { OverlayNotice } from './overlay';
import { createPipeline } from './pipeline';
import { json, text } from './response';
import { createRouter, type Route } from './router';
import type { Schema } from './validate';

const titleSchema: Schema<{ title: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => {
      const record = (typeof value === 'object' && value !== null ? value : {}) as {
        title?: unknown;
      };
      return typeof record.title === 'string'
        ? { value: { title: record.title } }
        : { issues: [{ message: 'must be a string', path: ['title'] }] };
    },
  },
};

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/public',
    meta: { name: 'public', auth: 'public' },
    handler: () => text('ok'),
  },
  {
    method: 'GET',
    path: '/private',
    meta: { name: 'private', auth: 'required' },
    handler: (_request, ctx) => json({ locale: ctx.locale, tz: ctx.tz }),
  },
  {
    method: 'POST',
    path: '/posts',
    meta: { name: 'posts.create', auth: 'public', input: titleSchema },
    handler: (_request, ctx) => json({ input: ctx.input }),
  },
  {
    method: 'GET',
    path: '/guarded',
    meta: { name: 'guarded', auth: 'public', policy: 'post:publish' },
    handler: () => text('never reached'),
  },
  {
    method: 'GET',
    path: '/self-guarded',
    meta: { name: 'self-guarded', auth: 'public', policy: 'post:publish', enforcedBy: 'handler' },
    handler: () => text('the handler decided'),
  },
  {
    method: 'GET',
    path: '/posts/:id',
    meta: { name: 'posts.show', auth: 'public' },
    handler: () => text('one post'),
  },
  {
    method: 'GET',
    path: '/boom/:id',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError('undefined is not a function');
    },
  },
];

const get = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('devNotices is consulted on the overlay path and nowhere else', () => {
  const notice: OverlayNotice = {
    code: 'X_N_PLUS_ONE_QUERY',
    cause: '31 identical selects on post.author in one request',
    // A real, pasteable line: this fixture stands in for what `@ultimat3/entity` produces, and a
    // command that does not exist would model a `fix:` the error contract refuses.
    fix: "db.posts.preload('author')   # one statement for the whole page",
  };
  const browser = { headers: { accept: 'text/html' } };
  const agent = { headers: { accept: 'application/json' } };

  interface NoticeProbe {
    readonly dev: boolean;
    /** Omitted means the host wired no hook at all — the shape every app but `x dev` has. */
    readonly found?: readonly OverlayNotice[];
  }

  const probe = (options: NoticeProbe) => {
    let calls = 0;
    const found = options.found;
    const devNotices = (): readonly OverlayNotice[] => {
      calls += 1;
      return found ?? [];
    };
    const pipeline = createPipeline({
      table: createRouter(routes),
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        dev: options.dev,
        buildId: null,
        hostname: '127.0.0.1',
      }),
      hooks: found === undefined ? {} : { devNotices },
    });
    return { pipeline, calls: () => calls };
  };

  test('a browser debugging a throw in dev sees the findings beside the error', async () => {
    const { pipeline, calls } = probe({ dev: true, found: [notice] });
    const response = await pipeline.handle(get('/boom/7', browser), { role: 'web' });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(calls()).toBe(1);
    expect(body).toContain('<h2>notices</h2>');
    expect(body).toContain('<dt>X_N_PLUS_ONE_QUERY</dt>');
    // Verbatim once the browser has decoded it: a `fix:` is copied and run, so the overlay may
    // reflow nothing and re-quote nothing. HTML entities are not a reflow — `&#39;` is pasted as
    // `'` — and the escape set has to be complete, `"` (already) and `'` alike, or the next
    // single-quoted attribute someone writes here inherits a hole.
    expect(body).toContain(
      `<code>db.posts.preload(&#39;author&#39;)   # one statement for the whole page</code>`,
    );
  });

  test('a production process never asks — not once, not even on the error path', async () => {
    const { pipeline, calls } = probe({ dev: false, found: [notice] });
    const response = await pipeline.handle(get('/boom/7', browser), { role: 'web' });

    expect(response.status).toBe(500);
    // A browser in production gets the framework's error PAGE, not the overlay and not the
    // problem document — and a notice is an overlay card, so this page is the proof it was never
    // asked for: `calls()` says the hook did not run, and the body says nothing rendered it.
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(calls()).toBe(0);
    const body = await response.text();
    expect(body).not.toContain('X_N_PLUS_ONE_QUERY');
    expect(body).not.toContain('<h2>notices</h2>');
  });

  test('an agent asking for json in dev is not charged for a card it will never render', async () => {
    const { pipeline, calls } = probe({ dev: true, found: [notice] });
    const response = await pipeline.handle(get('/boom/7', agent), { role: 'web' });

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(calls()).toBe(0);
  });

  test('a request that did not fail never asks: there is no overlay to hang a notice off', async () => {
    const { pipeline, calls } = probe({ dev: true, found: [notice] });

    expect((await pipeline.handle(get('/public', browser), { role: 'web' })).status).toBe(200);
    expect(calls()).toBe(0);
  });

  test('a host with no hook, and a hook that found nothing, both render the overlay unchanged', async () => {
    const junction = '  </section>\n  <section class="card">\n    <h2>terminal</h2>';
    for (const options of [{ dev: true }, { dev: true, found: [] }]) {
      const { pipeline } = probe(options);
      const body = await (await pipeline.handle(get('/boom/7', browser), { role: 'web' })).text();

      expect(body).not.toContain('<h2>notices</h2>');
      expect(body).toContain(junction);
    }
  });
});
