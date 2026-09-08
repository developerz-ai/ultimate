/**
 * The states the contact-sales enquiry can be photographed in, and this island's own reason no
 * picture comes out of the file yet — a DIFFERENT one from the two socket islands', which is why
 * it is written here rather than cross-referenced.
 *
 * **This island takes the SERVER's markup over; it renders none of its own.** `mount` reads
 * `el.querySelector('form')` and returns untouched when the wrapper holds no form, because the form
 * posts on its own and a half-attached listener is worse than none. The shot harness mounts an
 * island into an EMPTY host — it has `data-x-entry` and `data-x-props` and no shell — so `mount`
 * takes its early return, the host element ends up with no children and no text, and
 * `photographFault` refuses the shutter with "it mounted and rendered nothing"
 * (`packages/cli/src/island-capture.ts`). Closing it means a way for a state to declare the server
 * markup it is mounted over, which `IslandStateDecl` has no field for.
 *
 * The three states below are the three strings this island exists to write into `[data-role=
 * "status"]` — the whole of what it adds to a page that already works without scripting — so the
 * list is complete rather than a sample. None of the three is reachable by clicking without a
 * server that really answers, or really refuses.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely — the command that takes the pictures has to know the
 * complete expected list before a browser exists. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross the
 * seam as JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { ContactSalesProps } from './contact-sales.island';

const BASE = {
  sendingLabel: 'Sending…',
  sentLabel: 'Thanks — we will be in touch within one business day.',
  failedLabel: 'That did not send. Try again, or email sales@postly.example.',
} satisfies ContactSalesProps;

export const contactSalesStates = defineIslandStates({
  island: 'apps/web/site/pricing/contact-sales.island.tsx',
  viewport: { width: 560, height: 320 },
  states: [
    {
      id: 'sending',
      title: 'the enquiry is in flight',
      note: 'you cannot hold this by clicking: it lasts one round trip to the action',
      props: BASE,
    },
    {
      id: 'sent',
      title: 'the action accepted the enquiry and the form has been reset',
      note: 'reaching this by hand means really filing an enquiry',
      props: BASE,
    },
    {
      id: 'failed',
      title: 'the action answered non-2xx and the visitor is told what else to do',
      note: 'you cannot reach this by clicking without a server that really refuses the post, which is the one state on this page a visitor is most likely to meet and nobody has ever seen',
      props: BASE,
      // The refusal this state IS. Declared even though the harness never clicks: an unstubbed
      // request fails a run, so the fixture is what proves the picture is of the failure notice
      // and not of a hung fetch.
      routes: [
        { match: 'POST /api/sales/contact', respond: { kind: 'json', status: 500, body: {} } },
      ],
    },
  ],
});
