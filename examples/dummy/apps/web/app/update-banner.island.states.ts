/**
 * The update banner's states. It has ONE a props object can reach: the first paint, which is empty
 * — the banner exists only after the service worker announces a build this document is not
 * running, and that is an event, never a prop. `long-labels` is the same empty paint with the
 * translated strings it would show; the picture proves they cost the layout nothing until then.
 *
 * PURE DATA — the one import is `import type`, erased by `verbatimModuleSyntax`
 * (`X_TEST_ISLAND_STATES_NOT_PURE`). The strings are literals because an island's props cross as
 * JSON the server already translated.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { UpdateBannerProps } from './update-banner.island';

const BASE = {
  label: 'A new version is ready.',
  action: 'Reload',
} satisfies UpdateBannerProps;

export const updateBannerStates = defineIslandStates({
  island: 'apps/web/app/update-banner.island.tsx',
  viewport: { width: 720, height: 120 },
  states: [
    {
      id: 'idle',
      title: 'the first paint: nothing, until a new build is announced',
      props: BASE,
    },
    {
      id: 'long-labels',
      title: 'the same paint carrying labels three times as long',
      note: 'you cannot reach this by clicking: it needs a locale this app was not written in',
      props: {
        label: 'O versiune nouă a aplicației este disponibilă și poate fi încărcată acum.',
        action: 'Reîncarcă pagina acum',
      },
    },
  ],
});
