// The dev error overlay. It renders the SAME facts object the terminal prints and
// `--json` emits, so a code/cause/fix string can never differ between the three
// surfaces. Labels here ("cause", "fix", "notices") are protocol strings from the
// error contract, not UI copy, so they are not routed through the i18n catalog.
import { factsOf, renderErrorLines, toProblem } from './error-map';
import { acceptsHtml, escapeHtml } from './html-render';
import { OVERLAY_STYLE } from './overlay-style';
import { html } from './response';

/**
 * An `href` is a SCHEME decision, not an escaping one: `javascript:alert(1)` survives every entity
 * replacement intact and becomes a link the agent debugging this page clicks. A `docs` value comes
 * from whichever package raised the error, so anything that is not plainly http(s) renders as text.
 */
const docsLink = (value: string): string => {
  const protocol = URL.parse(value)?.protocol;
  const safe = protocol === 'https:' || protocol === 'http:';
  return safe ? `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>` : escapeHtml(value);
};

/**
 * A non-fatal finding rendered next to the error: the same code/cause/fix contract, from a
 * diagnostic that did not stop the request. Declared structurally — the packages that produce
 * one (`@ultimat3/entity`'s N+1 codes, reported by `x dev`) are this tier or above and can
 * never be imported here, exactly as `AuthzDecision` is declared and never imported.
 */
export interface OverlayNotice {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string;
}

export interface OverlayMeta {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly buildId?: string | null;
  readonly notices?: readonly OverlayNotice[];
}

// One `<dd>` per finding, holding the cause and the runnable fix — the same two lines the
// terminal prints under a code, so a notice cannot say something the CLI would not.
const noticeRow = (notice: OverlayNotice): string =>
  `<dt>${escapeHtml(notice.code)}</dt><dd>${escapeHtml(notice.cause)}<br><code>${escapeHtml(
    notice.fix,
  )}</code>${notice.docs === undefined ? '' : `<br>${docsLink(notice.docs)}`}</dd>`;

/**
 * Nothing at all when there is nothing to report — not an empty card. A request with no findings
 * must render the bytes this file rendered before notices existed, or every host that never
 * supplies one still pays for the feature with a card that says nothing. The trailing indent is
 * part of that: it leaves the card after this one exactly where it already sat.
 */
const noticesCard = (notices: readonly OverlayNotice[]): string =>
  notices.length === 0
    ? ''
    : `<section class="card notices">
    <h2>notices</h2>
    <dl>
      ${notices.map(noticeRow).join('\n      ')}
    </dl>
  </section>
  `;

export const renderOverlay = (error: unknown, meta: OverlayMeta = {}): string => {
  const facts = factsOf(error);
  const problem = toProblem(error, {
    ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
    ...(meta.path === undefined ? {} : { instance: meta.path }),
    // The overlay is rendered on the dev branch and nowhere else (`stages.ts`), and its whole job
    // is showing the developer the cause a production caller may not see.
    dev: true,
  });
  const where = `${meta.method ?? ''} ${meta.path ?? ''}`.trim();
  return `<style>${OVERLAY_STYLE}</style>
<main>
  <section class="card">
    <h1>${escapeHtml(facts.code)} <span class="title">${escapeHtml(facts.title)}</span></h1>
    <dl>
      <dt>cause</dt><dd>${escapeHtml(facts.cause)}</dd>
      <dt>fix</dt><dd><code>${escapeHtml(facts.fix)}</code></dd>
      <dt>docs</dt><dd>${docsLink(facts.docs)}</dd>
      ${where === '' ? '' : `<dt>route</dt><dd>${escapeHtml(where)}</dd>`}
      ${meta.requestId === undefined ? '' : `<dt>request</dt><dd>${escapeHtml(meta.requestId)}</dd>`}
      ${
        meta.buildId === undefined || meta.buildId === null
          ? ''
          : `<dt>build</dt><dd>${escapeHtml(meta.buildId)}</dd>`
      }
    </dl>
  </section>
  ${noticesCard(meta.notices ?? [])}<section class="card">
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

/**
 * Dev only, and only when the caller is a browser: agents and RPC want problem+json. The sniff
 * itself is `acceptsHtml`, shared with the production error page — the two documents answer the
 * same caller in two environments, so asking the question twice is how one of them starts
 * disagreeing with the other.
 */
export const wantsOverlay = (request: Request): boolean => acceptsHtml(request);
