// The `/_x` timeline waterfall's rules, inlined into the shell's one `<style>` (`server.ts`) — /_x
// has no stylesheet pipeline, and the CSP hash a host computes is of that whole text. Colours are
// the shell's `--x-color-*` tokens only; each span kind takes one `chart-*` series role.

import { SPAN_KINDS } from './timeline-waterfall';

/**
 * The timeline's waterfall (`timeline-waterfall.ts`): a label column, a track whose bar is placed
 * by the row's own `--offset`/`--width` (server-computed shares), and the duration. Below 720px the
 * label takes its own line, so a long SQL text never squeezes the track to nothing on a phone.
 */
export const WATERFALL_STYLE = `
h2 { font-size: .875rem; margin: 0 0 .5rem; }
.tl { display: grid; gap: 1.5rem; }
@media (min-width: 1024px) { .tl { grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr); } }
.tl-requests ol, .tl-kinds, .tl-flame, .tl-loops ul { list-style: none; margin: 0; padding: 0; }
.tl-requests li { display: flex; justify-content: space-between; gap: .5rem; padding: .25rem 0;
  border-bottom: 1px solid rgb(var(--x-color-line)); }
.tl-requests a { overflow-wrap: anywhere; }
.tl-requests a[aria-current] { color: rgb(var(--x-color-fg)); font-weight: 700; }
.tl-ms { color: rgb(var(--x-color-fg-muted)); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tl-kinds { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin-bottom: 1rem; }
.tl-swatch { display: inline-block; inline-size: .75rem; block-size: .75rem; border-radius: 2px;
  margin-inline-end: .375rem; vertical-align: -1px; background: rgb(var(--tl-color)); }
.tl-row { display: grid; grid-template-columns: minmax(0, 1fr) 4.5rem; gap: .125rem .75rem;
  align-items: center; padding: .25rem 0; border-bottom: 1px solid rgb(var(--x-color-line)); }
.tl-label { grid-column: 1 / -1; display: flex; gap: .5rem; align-items: baseline; min-inline-size: 0;
  padding-inline-start: calc(var(--depth) * .75rem); }
@media (min-width: 720px) {
  .tl-row { grid-template-columns: minmax(0, 22rem) minmax(0, 1fr) 4.5rem; }
  .tl-label { grid-column: auto; }
}
.tl-kind { flex: none; padding: 0 .375rem; border-radius: 2px; font-size: .75rem;
  border: 1px solid rgb(var(--tl-color)); color: rgb(var(--x-color-fg)); }
.tl-name { flex: none; }
.tl-detail { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: rgb(var(--x-color-fg-muted)); }
.tl-track { position: relative; block-size: .875rem; border-radius: 2px;
  background: rgb(var(--x-color-line) / .35); }
.tl-bar { position: absolute; inset-block: 0; inset-inline-start: var(--offset);
  inline-size: max(var(--width), 2px); border-radius: 2px; background: rgb(var(--tl-color)); }
.tl-row > .tl-ms { text-align: end; }
.tl-loops { margin-top: 1.5rem; }
.tl-loops li { padding: .5rem 0; border-bottom: 1px solid rgb(var(--x-color-line)); }
.tl-empty { color: rgb(var(--x-color-fg-muted)); }
${SPAN_KINDS.map((kind, index) => `[data-kind="${kind}"] { --tl-color: var(--x-color-chart-${index + 1}); }`).join('\n')}
`;
