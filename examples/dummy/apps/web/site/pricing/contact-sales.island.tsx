// ContactSales: the interactive half of an otherwise static page, and the only module on this
// route the browser downloads.
//
// The page names this file by SPECIFIER, never by import:
//   const ContactSales = island({ src: './contact-sales.island.tsx', props: [...] });
// A string has no import edge, so nothing follows one into this file and the page's bundle graph
// stays the page's (axiom 6). WHEN it wakes is the route's `hydrate`, never a declaration here.
//
// Everything on screen is server-rendered inside this island's wrapper — the disclosure, the form
// and every label — so the enquiry sends with scripting off. What this module adds is the part a
// full page load cannot do: keep the visitor on `/pricing` and answer them in place.

import type { Api } from '../../api';
import { browserClient } from '../../shared/browser-client';
import { enquiryFrom } from './enquiry';

/** `contactSales`'s input, read off the action's type — `Api` is a type-only import. */
type ContactSalesInput = Parameters<Api['actions']['contactSales']>[0];

/**
 * What the server sends. JSON only, and already translated: an island's props cross the seam as
 * text in the document, so a callback cannot travel and neither can `t()`'s catalog. These three
 * are the states that exist only after a click — every other string is in the markup above.
 */
export interface ContactSalesProps {
  readonly sendingLabel: string;
  readonly sentLabel: string;
  readonly failedLabel: string;
}

/**
 * The one export the hydration runtime calls — `import(entry).then((m) => m.mount(el, props))`.
 * `el` is the wrapper the page rendered, with the server's own markup already inside it, so this
 * takes the markup over rather than replacing it: a replace is a visible flash on every load.
 */
export function mount(el: HTMLElement, props: ContactSalesProps): void {
  const form = el.querySelector('form');
  const status = el.querySelector<HTMLElement>('[data-role="status"]');
  // A shell this mount does not recognise is left exactly as the server rendered it. The form
  // posts to the action on its own; a listener that half-attached would be worse than none.
  if (!(form instanceof HTMLFormElement) || status === null) return;

  form.addEventListener('submit', (event) => {
    const enquiry = enquiryFrom(new FormData(form));
    // Hand it back to the browser: a native POST to the same action still sends the enquiry, and
    // `setRedirect` on the server is what answers it. Never a silent no-op.
    if (enquiry === null) return;

    event.preventDefault();
    status.textContent = props.sendingLabel;

    // The typed client from `shared/`, never a raw `fetch`: one naming rule, one transport. The
    // form's fields are strings and the action's plan, currency and locale are enumerations, so
    // the cast is the wire's own shape — the server validates every field against the catalog.
    browserClient
      .contactSales(enquiry as ContactSalesInput)
      .then(() => {
        status.textContent = props.sentLabel;
        form.reset();
      })
      .catch(() => {
        status.textContent = props.failedLabel;
      });
  });
}
