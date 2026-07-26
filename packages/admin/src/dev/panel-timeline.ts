// Panel: Request timeline.
// Kills: "where did the 800ms go?" — a flamegraph of one request: SQL, cache hits, action
// calls, and policy decisions on one axis, with the N+1 already counted for you.

import type { RequestTrace, SpanKind, TimelineSpan } from './facts';
import type { DevPanel } from './panel';

export interface FlameRow {
  readonly span: TimelineSpan;
  readonly depth: number;
  /** 0..1 of the request's total duration — the bar's width, computed once, server-side. */
  readonly offset: number;
  readonly width: number;
}

export interface TimelinePanelData {
  readonly requests: readonly {
    readonly requestId: string;
    readonly path: string;
    readonly totalMs: number;
  }[];
  readonly selected: RequestTrace | null;
  readonly flame: readonly FlameRow[];
  readonly totalsByKind: Readonly<Record<string, number>>;
  /** Same SQL text more than once in one request. The N+1 detector. */
  readonly repeatedSql: readonly { readonly sql: string; readonly count: number }[];
}

function flatten(trace: RequestTrace): readonly FlameRow[] {
  const byParent = new Map<string | null, TimelineSpan[]>();
  for (const span of trace.spans) {
    const bucket = byParent.get(span.parentId) ?? [];
    bucket.push(span);
    byParent.set(span.parentId, bucket);
  }
  const total = trace.totalMs === 0 ? 1 : trace.totalMs;
  const rows: FlameRow[] = [];

  const walk = (parentId: string | null, depth: number): void => {
    for (const span of (byParent.get(parentId) ?? []).sort((a, b) => a.startMs - b.startMs)) {
      rows.push({ span, depth, offset: span.startMs / total, width: span.durationMs / total });
      walk(span.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export const timelinePanel: DevPanel<TimelinePanelData> = {
  key: 'timeline',
  titleKey: 'dev.panel.timeline',
  question: 'where did the time go in this request?',
  async data(sources, params): Promise<TimelinePanelData> {
    const traces = await sources.traces();
    const wanted = params.get('requestId');
    const selected =
      (wanted === null ? traces[0] : traces.find((trace) => trace.requestId === wanted)) ?? null;

    const totalsByKind: Record<string, number> = {};
    const sqlCounts = new Map<string, number>();
    for (const span of selected?.spans ?? []) {
      const kind: SpanKind = span.kind;
      totalsByKind[kind] = (totalsByKind[kind] ?? 0) + span.durationMs;
      if (kind === 'sql') sqlCounts.set(span.detail, (sqlCounts.get(span.detail) ?? 0) + 1);
    }

    return {
      requests: traces.map((trace) => ({
        requestId: trace.requestId,
        path: trace.path,
        totalMs: trace.totalMs,
      })),
      selected,
      flame: selected === null ? [] : flatten(selected),
      totalsByKind,
      repeatedSql: [...sqlCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([sql, count]) => ({ sql, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
};
