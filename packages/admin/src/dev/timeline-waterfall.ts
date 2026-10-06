// The `/_x` timeline tab, drawn: the selected request's spans as a waterfall — one row per span,
// indented under its parent, its bar placed and sized by the server from the payload's own
// `offset`/`width` — beside the recent requests, the time per kind and the N+1 verdicts. Plain
// escaped HTML on the shell's tokens: `/_x` loads no Solid and no stylesheet pipeline to draw it.

import { escapeHtml } from '@ultimat3/core';
import { t } from './dev-t';
import type { SpanKind, StatementLoopFact } from './facts';
import type { FlameRow, TimelinePanelData } from './panel-timeline';

/** Every kind a span can be, in the order the legend lists them — and the colour slot each takes. */
export const SPAN_KINDS: readonly SpanKind[] = [
  'http',
  'render',
  'action',
  'policy',
  'sql',
  'cache',
  'job',
];

/** `/_x` is the framework's English tool; a duration reads to a tenth of a millisecond. */
const MS = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const ms = (value: number): string => t('dev.panel.timeline.ms', { ms: MS.format(value) });

/** A 0..1 share as a CSS percentage: two decimals at most, never `-0`, clamped to the track. */
const percent = (share: number): string => {
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  const text = (clamped * 100).toFixed(2).replace(/\.?0+$/, '');
  return `${text === '-0' ? '0' : text}%`;
};

const kindLabel = (kind: SpanKind): string => t(`dev.panel.timeline.kind.${kind}`);

const kindTag = (kind: SpanKind): string =>
  `<span class="tl-kind">${escapeHtml(kindLabel(kind))}</span>`;

function requestList(data: TimelinePanelData, tabPath: string): string {
  const shown = data.selected?.requestId;
  const items = data.requests
    .map((request) => {
      const href = `${tabPath}?requestId=${encodeURIComponent(request.requestId)}`;
      const current = request.requestId === shown ? ' aria-current="true"' : '';
      return `<li><a href="${escapeHtml(href)}"${current}>${escapeHtml(request.path)}</a> <span class="tl-ms">${escapeHtml(ms(request.totalMs))}</span></li>`;
    })
    .join('');
  const title = escapeHtml(t('dev.panel.timeline.requests'));
  return `<nav class="tl-requests" aria-label="${title}"><h2>${title}</h2><ol>${items}</ol></nav>`;
}

function kindTotals(data: TimelinePanelData): string {
  const items = SPAN_KINDS.filter((kind) => Object.hasOwn(data.totalsByKind, kind))
    .map(
      (kind) =>
        `<li><span class="tl-swatch" data-kind="${kind}" aria-hidden="true"></span>${escapeHtml(kindLabel(kind))} <span class="tl-ms">${escapeHtml(ms(data.totalsByKind[kind] ?? 0))}</span></li>`,
    )
    .join('');
  return `<ul class="tl-kinds" aria-label="${escapeHtml(t('dev.panel.timeline.byKind'))}">${items}</ul>`;
}

function row(flame: FlameRow): string {
  const { span } = flame;
  const style = `--depth:${flame.depth};--offset:${percent(flame.offset)};--width:${percent(flame.width)}`;
  const detail =
    span.detail === ''
      ? ''
      : `<code class="tl-detail" title="${escapeHtml(span.detail)}">${escapeHtml(span.detail)}</code>`;
  return `<li class="tl-row" data-kind="${span.kind}" style="${style}"><span class="tl-label">${kindTag(span.kind)} <span class="tl-name">${escapeHtml(span.name)}</span>${detail}</span><span class="tl-track" aria-hidden="true"><span class="tl-bar"></span></span><span class="tl-ms">${escapeHtml(ms(span.durationMs))}</span></li>`;
}

function verdicts(loops: readonly StatementLoopFact[] | null): string {
  const title = `<h2>${escapeHtml(t('dev.panel.timeline.nPlusOne.title'))}</h2>`;
  if (loops === null) {
    return `<section class="tl-loops">${title}<p class="question">${escapeHtml(t('dev.panel.timeline.nPlusOne.unwired'))}</p></section>`;
  }
  if (loops.length === 0) {
    return `<section class="tl-loops">${title}<p class="question">${escapeHtml(t('dev.panel.timeline.nPlusOne.clean'))}</p></section>`;
  }
  const items = loops
    .map(
      (loop) =>
        `<li><strong>${escapeHtml(loop.code)}</strong> ${escapeHtml(loop.cause)}<br><span class="question">${escapeHtml(t('dev.panel.timeline.nPlusOne.fix'))}</span> <code>${escapeHtml(loop.fix)}</code></li>`,
    )
    .join('');
  return `<section class="tl-loops">${title}<ul>${items}</ul></section>`;
}

/** The tab body. Pure over the panel's data, so the `--json` payload and the drawing agree. */
export function timelineHtml(data: TimelinePanelData, tabPath: string): string {
  const selected = data.selected;
  if (selected === null) {
    return `<p class="tl-empty">${escapeHtml(t('dev.panel.timeline.empty'))}</p>`;
  }
  const heading = `${selected.method} ${selected.path} · ${selected.status} · ${ms(selected.totalMs)}`;
  return `<div class="tl">${requestList(data, tabPath)}<section class="tl-trace" aria-labelledby="tl-heading"><h2 id="tl-heading">${escapeHtml(heading)}</h2>${kindTotals(data)}<ol class="tl-flame" aria-label="${escapeHtml(t('dev.panel.timeline.spans'))}">${data.flame.map(row).join('')}</ol>${verdicts(data.nPlusOne)}</section></div>`;
}
