import { describe, expect, test } from 'bun:test';
import { defaultDevSources, staticDevSources } from './data';
import type { DevSources, RequestTrace, StatementLoopFact, TimelineSpan } from './facts';
import { timelinePanel } from './panel-timeline';

const SELECT_MEMBER = 'select * from members where id = $1';

const sqlSpan = (id: string, detail: string, startMs: number): TimelineSpan => ({
  id,
  parentId: 'root',
  kind: 'sql',
  name: 'db.select',
  startMs,
  durationMs: 2,
  detail,
});

const trace = (requestId: string, sql: readonly string[]): RequestTrace => ({
  requestId,
  method: 'GET',
  path: `/feed/${requestId}`,
  status: 200,
  startedAt: '2026-08-13T09:00:00.000Z',
  totalMs: 100,
  spans: [
    {
      id: 'root',
      parentId: null,
      kind: 'http',
      name: 'GET /feed',
      startMs: 0,
      durationMs: 100,
      detail: '',
    },
    ...sql.map((detail, index) => sqlSpan(`s${index}`, detail, index + 1)),
  ],
});

const loop = (requestId: string, over: Partial<StatementLoopFact> = {}): StatementLoopFact => ({
  requestId,
  code: 'X_N_PLUS_ONE_QUERY',
  cause: `50 identical statements on members via findById in ${requestId}`,
  fix: "posts.preload('author')",
  docs: null,
  subject: 'members.findById',
  count: 50,
  sample: SELECT_MEMBER,
  ...over,
});

const TRACES: readonly RequestTrace[] = [
  trace('req_1', [SELECT_MEMBER, SELECT_MEMBER, 'select * from posts']),
  trace('req_2', ['select * from posts']),
];

const traceSource = { traces: async (): Promise<readonly RequestTrace[]> => TRACES };

const sourcesWith = (loops: readonly StatementLoopFact[]): DevSources =>
  staticDevSources({ ...traceSource, statementLoops: async () => loops });

/** What `repeatedSql` must keep answering for `TRACES[0]`, whatever the detector says. */
const MEASURED = [{ sql: SELECT_MEMBER, count: 2 }];

describe('timelinePanel renders the detector, it does not re-derive it', () => {
  test('a host with traces but no detector still gets its timeline, and nPlusOne is null', async () => {
    // `statementLoops` is the real unwired source here: it rejects with X_NOT_IMPLEMENTED. Without
    // the panel's `.catch`, that rejection escapes `data()` and there is no flamegraph at all.
    const data = await timelinePanel.data(
      defaultDevSources({ hooks: traceSource }),
      new URLSearchParams(),
    );

    expect(data.nPlusOne).toBeNull();
    expect(data.selected?.requestId).toBe('req_1');
    expect(data.flame).toHaveLength(4);
    expect(data.requests.map((entry) => entry.requestId)).toEqual(['req_1', 'req_2']);
    expect(data.repeatedSql).toEqual(MEASURED);
  });

  test("only the selected request's verdicts come back", async () => {
    const mine = loop('req_1');
    const theirs = loop('req_2', { subject: 'posts.findById', count: 9 });

    const data = await timelinePanel.data(sourcesWith([mine, theirs]), new URLSearchParams());

    // Verdicts are counted per request; showing another request's loop under this flamegraph
    // would blame the wrong request for the wrong statements.
    expect(data.nPlusOne).toEqual([mine]);
  });

  test("?requestId= picks that request's verdicts, not the newest request's", async () => {
    const mine = loop('req_1');
    const theirs = loop('req_2', { code: 'X_N_PLUS_ONE_WRITE', fix: 'insertAll(rows)' });

    const data = await timelinePanel.data(
      sourcesWith([mine, theirs]),
      new URLSearchParams({ requestId: 'req_2' }),
    );

    expect(data.selected?.requestId).toBe('req_2');
    expect(data.nPlusOne).toEqual([theirs]);
  });

  test('no trace selected answers [] — no request is on screen to have looped', async () => {
    const sources = staticDevSources({ statementLoops: async () => [loop('req_1')] });

    const data = await timelinePanel.data(sources, new URLSearchParams());

    expect(data.selected).toBeNull();
    // `[]`, not `null` (the detector answered) and not the whole ledger (it belongs to req_1).
    expect(data.nPlusOne).toEqual([]);
  });

  test("an unknown ?requestId= selects nothing, and inherits nobody's verdicts", async () => {
    const data = await timelinePanel.data(
      sourcesWith([loop('req_1'), loop('req_2')]),
      new URLSearchParams({ requestId: 'req_missing' }),
    );

    expect(data.selected).toBeNull();
    expect(data.nPlusOne).toEqual([]);
  });

  test("the ledger's order survives the panel - it is not re-sorted by count", async () => {
    const first = loop('req_1', { subject: 'members.findById', count: 6 });
    const second = loop('req_1', { subject: 'posts.findById', count: 40 });

    const data = await timelinePanel.data(sourcesWith([first, second]), new URLSearchParams());

    // The ledger orders newest first; a `count` sort here would be this panel deciding what
    // matters most, and would disagree with the order `x dev` printed for the same request.
    expect(data.nPlusOne).toEqual([first, second]);
  });

  test('repeatedSql stays the measurement: identical with a verdict, without one, and unwired', async () => {
    const withVerdict = await timelinePanel.data(
      sourcesWith([loop('req_1', { subject: 'members.findById', count: 50 })]),
      new URLSearchParams(),
    );
    const withoutVerdict = await timelinePanel.data(sourcesWith([]), new URLSearchParams());
    const unwired = await timelinePanel.data(
      defaultDevSources({ hooks: traceSource }),
      new URLSearchParams(),
    );

    // The measurement counts SQL texts in THIS trace (`count > 1`, sorted desc) and nothing else:
    // the verdict's own subject and count never leak into it, or the two would drift apart.
    expect(withVerdict.repeatedSql).toEqual(MEASURED);
    expect(withoutVerdict.repeatedSql).toEqual(MEASURED);
    expect(unwired.repeatedSql).toEqual(MEASURED);
    expect(withVerdict.repeatedSql.map((entry) => entry.sql)).not.toContain('members.findById');
    expect(withoutVerdict.nPlusOne).toEqual([]);
  });

  test('repeatedSql counts every SQL text over one, most repeated first', async () => {
    const busy = trace('req_3', ['a', 'b', 'a', 'b', 'a', 'c']);
    const sources = staticDevSources({
      traces: async (): Promise<readonly RequestTrace[]> => [busy],
      statementLoops: async () => [],
    });

    const data = await timelinePanel.data(sources, new URLSearchParams());

    expect(data.repeatedSql).toEqual([
      { sql: 'a', count: 3 },
      { sql: 'b', count: 2 },
    ]);
  });
});
