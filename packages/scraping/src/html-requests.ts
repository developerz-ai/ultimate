// The subresource requests a document would make, read out of its markup. The offline drivers
// have no network stack, so this is how they still exercise interception: an `<img>` pointing at
// a host `allowHosts` does not list produces the same refused network entry offline that a real
// browser produces on the wire.

import { queryHtml } from './html-query';
import type { ResourceType } from './rings';

export interface MarkupRequest {
  readonly url: string;
  readonly resourceType: ResourceType;
}

/** Selector, attribute and the type a browser would classify it as. `<a href>` is not a request. */
const SOURCES: readonly (readonly [string, string, ResourceType])[] = [
  ['img', 'src', 'image'],
  ['script', 'src', 'script'],
  ['link', 'href', 'stylesheet'],
  ['iframe', 'src', 'document'],
  ['source', 'src', 'media'],
  ['video', 'src', 'media'],
  ['audio', 'src', 'media'],
];

/** Absolute URLs only: a relative one resolves against `base`, which is the page's own URL. */
export async function markupRequests(
  html: string,
  base: string,
): Promise<readonly MarkupRequest[]> {
  const requests: MarkupRequest[] = [];
  for (const [selector, attribute, resourceType] of SOURCES) {
    for (const element of await queryHtml(html, selector)) {
      const raw = element.attrs[attribute];
      if (raw === undefined || raw === '') continue;
      // `<link>` covers icons, preloads and manifests too; only a stylesheet is a stylesheet.
      if (selector === 'link' && (element.attrs['rel'] ?? '') !== 'stylesheet') continue;
      try {
        requests.push({ url: new URL(raw, base).toString(), resourceType });
      } catch {
        // A specifier no URL parser accepts is not a request any browser would make either.
      }
    }
  }
  return requests;
}
