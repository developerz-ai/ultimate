// Panel: Request timeline.
// Kills: "where did the 800ms go?" — a waterfall of one request: SQL, cache hits, action
// calls, and policy decisions on one axis, with the N+1 already counted for you — counted by
// `x dev`'s statement ledger and read here through `statementLoops()`, never re-derived.

import { DevSourceUnavailableError } from '../errors';
import type { RequestTrace, SpanKind, StatementLoopFact, TimelineSpan } from './facts';
import type { DevPanel } from './panel';
import { timelineHtml } from './timeline-waterfall';

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
  /** Same SQL text more than once in one request. A measurement over this trace, not a verdict. */
  readonly repeatedSql: readonly { readonly sql: string; readonly count: number }[];
  /**
   * The detector's verdicts for the selected request, or `null` when no detector is installed.
   *
   * Two fields and not one, deliberately: `repeatedSql` above is a **measurement** over the trace
   * this panel recorded — every SQL text that appeared twice, whatever it was — while this is the
   * **verdict**, counted per request by `x dev`'s statement ledger with attribution applied and
   * `expectedQueryLoop` honoured. A measurement that started warning would be a second detector,
   * disagreeing with the one whose `fix:` an author actually pastes.
   */
  readonly nPlusOne: readonly StatementLoopFact[] | null;
}

/**
 * Depth-first by start time. A span whose parent is not in this recording — work handed off after
 * its trace's early spans were evicted, or a host's own parenting — is drawn at depth 0, as is one
 * caught in a parent cycle: `totalsByKind` counts every span, so the flame must draw every span,
 * and a walk from `null` alone left those out of it without a word.
 */
function flatten(trace: RequestTrace): readonly FlameRow[] {
  const ids = new Set(trace.spans.map((span) => span.id));
  const byParent = new Map<string | null, TimelineSpan[]>();
  for (const span of trace.spans) {
    const parent =
      span.parentId !== null && span.parentId !== span.id && ids.has(span.parentId)
        ? span.parentId
        : null;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(span);
    byParent.set(parent, bucket);
  }
  const total = trace.totalMs === 0 ? 1 : trace.totalMs;
  const rows: FlameRow[] = [];
  const drawn = new Set<TimelineSpan>();
  const byStart = (spans: readonly TimelineSpan[]) =>
    [...spans].sort((a, b) => a.startMs - b.startMs);

  const draw = (span: TimelineSpan, depth: number): void => {
    if (drawn.has(span)) return;
    drawn.add(span);
    rows.push({ span, depth, offset: span.startMs / total, width: span.durationMs / total });
    for (const child of byStart(byParent.get(span.id) ?? [])) draw(child, depth + 1);
  };
  for (const span of byStart(byParent.get(null) ?? [])) draw(span, 0);
  // Only a cycle of two or more spans is left: none of them is anyone's root.
  for (const span of byStart(trace.spans)) draw(span, 0);
  return rows;
}

export const timelinePanel: DevPanel<TimelinePanelData> = {
  key: 'timeline',
  titleKey: 'dev.panel.timeline.title',
  questionKey: 'dev.panel.timeline.question',
  async data(sources, params): Promise<TimelinePanelData> {
    const traces = await sources.traces();
    const wanted = params.get('requestId');
    const selected =
      (wanted === null ? traces[0] : traces.find((trace) => trace.requestId === wanted)) ?? null;
    // Degrade rather than reject, as `panel-live.ts` does for `subscribers`: a host with traces
    // but no detector installed must still get its flamegraph. `null` carries that difference —
    // "nobody counted" is not "counted, and this request was clean". Only for the error that MEANS
    // unwired: a detector that ran and failed is a diagnostic, never "no detector".
    const loops = await sources.statementLoops().catch((error: unknown): null => {
      if (!(error instanceof DevSourceUnavailableError)) throw error;
      return null;
    });

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
      // Scoped to the shown request and left in the ledger's own order — it already orders
      // newest first, and a second sort here would be this panel deciding what matters most.
      // With nothing selected the match is against `undefined`, so the answer is `[]`: no
      // request is on screen to have looped.
      nPlusOne:
        loops === null ? null : loops.filter((loop) => loop.requestId === selected?.requestId),
    };
  },
  /**
   * The waterfall, drawn from the data above — never a second read of the traces. With no data
   * handed there is nothing to draw, and the server folds the payload under an empty body.
   */
  async html(_params, tabPath, data) {
    return data === undefined ? '' : timelineHtml(data, tabPath);
  },
};
