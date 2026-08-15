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

import { enquiryFrom } from './enquiry';

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

    // A plain `fetch` to the form's own `action`, not the typed client: importing
    // `@ultimat3/action` for `rpc()` costs 36 kB in a browser bundle, which is thirty times this
    // island. The path is still the framework's — `derivePath` minted it on the server and it is
    // in the markup — so there is no second naming rule here, only a second transport.
    void fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(enquiry),
    })
      .then((response) => {
        status.textContent = response.ok ? props.sentLabel : props.failedLabel;
        if (response.ok) form.reset();
      })
      .catch(() => {
        status.textContent = props.failedLabel;
      });
  });
}
