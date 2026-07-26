// The dev error overlay. It renders the SAME facts object the terminal prints and
// `--json` emits, so a code/cause/fix string can never differ between the three
// surfaces. Labels here ("cause", "fix") are protocol strings from the error
// contract, not UI copy, so they are not routed through the i18n catalog.
import { factsOf, renderErrorLines, toProblem } from './error-map';
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

// Token definitions live here and nowhere else; every rule below uses var().
const STYLE = `
:root {
  --x-bg: #fbfbfd; --x-surface: #ffffff; --x-border: #e3e3ea;
  --x-text: #1b1b1f; --x-muted: #6b6b76; --x-danger: #b3261e; --x-accent: #2f4fd8;
  --x-code-bg: #f3f3f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --x-bg: #111115; --x-surface: #1a1a20; --x-border: #2e2e38;
    --x-text: #ececf1; --x-muted: #9b9baa; --x-danger: #ff8a80; --x-accent: #9db2ff;
    --x-code-bg: #22222b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem; background: var(--x-bg); color: var(--x-text);
  font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
main { max-width: 60rem; margin: 0 auto; }
.card {
  background: var(--x-surface); border: 1px solid var(--x-border);
  border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1rem;
}
h1 { font-size: 1.1rem; margin: 0 0 .25rem; color: var(--x-danger); }
h2 { font-size: .8rem; margin: 0 0 .5rem; color: var(--x-muted);
     text-transform: uppercase; letter-spacing: .08em; }
dl { display: grid; grid-template-columns: 5rem 1fr; gap: .35rem 1rem; margin: 0; }
dt { color: var(--x-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre { background: var(--x-code-bg); border-radius: 6px; padding: .75rem;
      margin: 0; overflow-x: auto; }
a { color: var(--x-accent); }
.title { color: var(--x-muted); font-weight: normal; }
`;

export const renderOverlay = (error: unknown, meta: OverlayMeta = {}): string => {
  const facts = factsOf(error);
  const problem = toProblem(error, {
    ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
    ...(meta.path === undefined ? {} : { instance: meta.path }),
  });
  const where = `${meta.method ?? ''} ${meta.path ?? ''}`.trim();
  return `<style>${STYLE}</style>
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
