// The dev error overlay. It renders the SAME facts object the terminal prints and
// `--json` emits, so a code/cause/fix string can never differ between the three
// surfaces. Labels here ("cause", "fix") are protocol strings from the error
// contract, not UI copy, so they are not routed through the i18n catalog.
import { factsOf, renderErrorLines, toProblem } from './error-map';
import { OVERLAY_STYLE } from './overlay-style';
import { html } from './response';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export interface OverlayMeta {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly buildId?: string | null;
}

export const renderOverlay = (error: unknown, meta: OverlayMeta = {}): string => {
  const facts = factsOf(error);
  const problem = toProblem(error, {
    ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
    ...(meta.path === undefined ? {} : { instance: meta.path }),
  });
  const where = `${meta.method ?? ''} ${meta.path ?? ''}`.trim();
  return `<style>${OVERLAY_STYLE}</style>
<main>
  <section class="card">
    <h1>${escapeHtml(facts.code)} <span class="title">${escapeHtml(facts.title)}</span></h1>
    <dl>
      <dt>cause</dt><dd>${escapeHtml(facts.cause)}</dd>
      <dt>fix</dt><dd><code>${escapeHtml(facts.fix)}</code></dd>
      <dt>docs</dt><dd><a href="${escapeHtml(facts.docs)}">${escapeHtml(facts.docs)}</a></dd>
      ${where === '' ? '' : `<dt>route</dt><dd>${escapeHtml(where)}</dd>`}
      ${meta.requestId === undefined ? '' : `<dt>request</dt><dd>${escapeHtml(meta.requestId)}</dd>`}
      ${
        meta.buildId === undefined || meta.buildId === null
          ? ''
          : `<dt>build</dt><dd>${escapeHtml(meta.buildId)}</dd>`
      }
    </dl>
  </section>
  <section class="card">
    <h2>terminal</h2>
    <pre>${escapeHtml(renderErrorLines(error))}</pre>
  </section>
  ${
    facts.stack === undefined
      ? ''
      : `<section class="card"><h2>stack</h2><pre>${escapeHtml(facts.stack)}</pre></section>`
  }
  <section class="card">
    <h2>json</h2>
    <pre>${escapeHtml(JSON.stringify(problem, null, 2))}</pre>
  </section>
</main>`;
};

export const overlayResponse = (error: unknown, meta: OverlayMeta = {}): Response =>
  html(renderOverlay(error, meta), {
    status: factsOf(error).status,
    headers: { 'cache-control': 'no-store' },
  });

/** Dev only, and only when the caller is a browser: agents and RPC want problem+json. */
export const wantsOverlay = (request: Request): boolean =>
  (request.headers.get('accept') ?? '').includes('text/html');
