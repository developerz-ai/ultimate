// Search, the one module of this site a browser downloads. The page renders the form, the status
// line and an empty result list; this takes them over: it reads the static index once, ranks
// with `searchDocs` — the function `x docs` ranks with — and lists the hits. No server, no
// `innerHTML`: every result is built from text nodes.

import { clientTransport } from '@ultimat3/core/page';
import { type DocEntry, searchDocs } from '@ultimat3/manifest/docs-search';
import { decodeIndex } from './search-index';

/** Already translated: an island's props cross the seam as text in the document. */
export interface SearchIslandProps {
  readonly indexPath: string;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly failedLabel: string;
}

const LIMIT = 12;

export function mount(el: HTMLElement, props: SearchIslandProps): () => void {
  // The disposer drops the submit listener: a router navigation leaves nothing listening.
  const listening = new AbortController();
  const dispose = (): void => listening.abort();
  const form = el.querySelector('form');
  const status = el.querySelector<HTMLElement>('[data-role="status"]');
  const results = el.querySelector<HTMLElement>('[data-role="results"]');
  const input = form?.elements.namedItem('q');
  if (form === null || status === null || results === null) return dispose;
  if (!(input instanceof HTMLInputElement)) return dispose;

  let index: Promise<readonly DocEntry[] | undefined> | undefined;
  const load = (): Promise<readonly DocEntry[] | undefined> => {
    // The one browser transport, as every client read. A refusal is the failed line on screen —
    // the visitor's answer — and the next query tries again rather than keeping a dead promise.
    index ??= clientTransport({ method: 'GET', url: props.indexPath }).then(decodeIndex, () => {
      index = undefined;
      return undefined;
    });
    return index;
  };

  const run = async (query: string): Promise<void> => {
    if (query.trim() === '') return;
    status.textContent = props.loadingLabel;
    const entries = await load();
    if (entries === undefined) {
      status.textContent = props.failedLabel;
      return;
    }
    const hits = searchDocs(entries, query, LIMIT);
    status.textContent = hits.length === 0 ? props.emptyLabel : '';
    results.replaceChildren(
      ...hits.map(({ entry }) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = entry.topic;
        link.textContent = entry.title;
        const text = document.createElement('p');
        text.textContent = entry.text;
        item.append(link, text);
        return item;
      }),
    );
  };

  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      const url = new URL(location.href);
      url.searchParams.set('q', input.value);
      history.replaceState(null, '', url);
      void run(input.value);
    },
    { signal: listening.signal },
  );
  // `/search?q=X_DB_DRIFT` is a link anyone can paste: the query in the address runs on arrival.
  const initial = new URL(location.href).searchParams.get('q') ?? '';
  if (initial !== '') {
    input.value = initial;
    void run(initial);
  }
  return dispose;
}
