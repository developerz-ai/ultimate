// The timeline tab, drawn: a waterfall of the selected request's spans — one row per span, its bar
// placed and sized by the server from the same `offset`/`width` the `--json` payload carries — the
// recent requests as links, time per kind, and the N+1 verdicts with their fix lines.

import { describe, expect, test } from 'bun:test';
import { defaultDevSources, staticDevSources } from './data';
import type { RequestTrace, StatementLoopFact } from './facts';
import { timelinePanel } from './panel-timeline';
import { timelineHtml } from './timeline-waterfall';

const TRACE: RequestTrace = {
  requestId: 'req_1',
  method: 'GET',
  path: '/feed?tab=<new>',
  status: 200,
  startedAt: '2026-10-05T09:00:00.000Z',
  totalMs: 200,
  spans: [
    {
      id: 'root',
      parentId: null,
      kind: 'http',
      name: 'GET /feed',
      startMs: 0,
      durationMs: 200,
      detail: '',
    },
    {
      id: 'q1',
      parentId: 'root',
      kind: 'sql',
      name: 'db.select',
      startMs: 50,
      durationMs: 25,
      detail: "select * from posts where body like '%<script>%'",
    },
    {
      id: 'p1',
      parentId: 'root',
      kind: 'policy',
      name: 'post:read',
      startMs: 10,
      durationMs: 5,
      detail: 'allowed',
    },
  ],
};

const OTHER: RequestTrace = { ...TRACE, requestId: 'req_2', path: '/inbox', totalMs: 40 };

const LOOP: StatementLoopFact = {
  requestId: 'req_1',
  code: 'X_N_PLUS_ONE_QUERY',
  cause: '50 identical statements on members',
  fix: "posts.preload('author')",
  docs: null,
  subject: 'members.findById',
  count: 50,
  sample: 'select * from members where id = $1',
};

const draw = async (
  loops: readonly StatementLoopFact[] | 'unwired',
  params = new URLSearchParams(),
): Promise<string> => {
  const traces = async (): Promise<readonly RequestTrace[]> => [TRACE, OTHER];
  // `defaultDevSources` with only traces hooked is the real unwired detector: it rejects.
  const sources =
    loops === 'unwired'
      ? defaultDevSources({ hooks: { traces } })
      : staticDevSources({ traces, statementLoops: async () => loops });
  return timelineHtml(await timelinePanel.data(sources, params), '/_x/timeline');
};

describe('the timeline tab is a waterfall, not a JSON dump', () => {
  test('one row per span, in start order under its parent, each bar placed by the server', async () => {
    const html = await draw([]);
    const rows = [...html.matchAll(/<li class="tl-row" data-kind="(\w+)" style="([^"]*)"/g)];
    expect(rows.map((row) => row[1])).toEqual(['http', 'policy', 'sql']);
    // offset = start / total, width = duration / total — the payload's own numbers, as CSS.
    expect(rows[0]?.[2]).toBe('--depth:0;--offset:0%;--width:100%');
    expect(rows[1]?.[2]).toBe('--depth:1;--offset:5%;--width:2.5%');
    expect(rows[2]?.[2]).toBe('--depth:1;--offset:25%;--width:12.5%');
  });

  test('every span reads without colour: its kind and its duration are text', async () => {
    const html = await draw([]);
    expect(html).toContain('<span class="tl-kind">sql</span>');
    expect(html).toContain('<span class="tl-ms">25 ms</span>');
    expect(html).toContain('<span class="tl-ms">200 ms</span>');
  });

  test('app-controlled text is escaped — a span detail and a path are data, never markup', async () => {
    const html = await draw([]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('/feed?tab=&lt;new&gt;');
  });

  test('the recent requests are links that select one, the shown one marked current', async () => {
    const html = await draw([], new URLSearchParams({ requestId: 'req_2' }));
    expect(html).toContain('href="/_x/timeline?requestId=req_2" aria-current="true"');
    expect(html).toContain('href="/_x/timeline?requestId=req_1"');
    expect(html).not.toContain('href="/_x/timeline?requestId=req_1" aria-current');
  });

  test('time per kind is summed over the selected request', async () => {
    const html = await draw([]);
    expect(html).toMatch(/data-kind="sql"[^<]*<\/span>sql <span class="tl-ms">25 ms<\/span>/);
  });

  test("the detector's verdict is shown with its fix; none wired and none found are different", async () => {
    const found = await draw([LOOP]);
    expect(found).toContain('X_N_PLUS_ONE_QUERY');
    expect(found).toContain('posts.preload(&#39;author&#39;)');
    const clean = await draw([]);
    expect(clean).toContain('no statement repeated');
    const unwired = await draw('unwired');
    expect(unwired).toContain('no N+1 detector is attached');
    expect(unwired).not.toContain('no statement repeated');
  });

  test('no trace yet says how to get one, instead of an empty chart', async () => {
    const sources = staticDevSources({ traces: async () => [], statementLoops: async () => [] });
    const html = timelineHtml(
      await timelinePanel.data(sources, new URLSearchParams()),
      '/_x/timeline',
    );
    expect(html).toContain('No request has been traced yet');
    expect(html).not.toContain('tl-row');
  });

  test('the panel draws through this module, once its data answered', async () => {
    const sources = staticDevSources({
      traces: async () => [TRACE],
      statementLoops: async () => [],
    });
    const params = new URLSearchParams();
    const data = await timelinePanel.data(sources, params);
    expect(await timelinePanel.html?.(params, '/_x/timeline', data)).toBe(
      timelineHtml(data, '/_x/timeline'),
    );
  });
});

describe('the shell paints every kind', () => {
  test('each span kind has its own series role in the inlined shell style', async () => {
    const { devShellStyle } = await import('./server');
    const { SPAN_KINDS } = await import('./timeline-waterfall');
    const style = await devShellStyle();
    SPAN_KINDS.forEach((kind, index) => {
      expect(style).toContain(`--x-color-chart-${index + 1}: `);
      expect(style).toContain(
        `[data-kind="${kind}"] { --tl-color: var(--x-color-chart-${index + 1}); }`,
      );
    });
  });
});
