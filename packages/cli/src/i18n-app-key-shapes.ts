// Every shape in an app's source whose literal is a catalog key. Here and not in `@ultimat3/i18n`:
// tier 1 must not name `blocks` or `defineMail`, and this package already sits over both. Passed by
// `scanSource` only, so the framework's own catalog scan (`scripts/lib/i18n-scan.ts`) keeps its
// callees: `mail.*` lives in `mail/src/catalog.ts`, not in `catalogs/en.json`.

import type { ExtractOptions } from '@ultimat3/i18n';

export const APP_KEY_SHAPES = {
  callees: [
    't',
    '$t',
    'translate',
    // The key is the first argument of each (`mail/src/blocks.ts`). `divider` takes none.
    // `i18n-app-key-shapes.test.ts` reads `blocks` itself, so a new block reds until listed here.
    'blocks.heading',
    'blocks.paragraph',
    'blocks.button',
    'blocks.callout',
    'blocks.detail',
  ],
  properties: [
    // A push payload's and an admin screen's keys. Unambiguous anywhere: nothing else is `*Key`.
    { name: 'titleKey' },
    { name: 'bodyKey' },
    // `subject:` alone is also a column, a form field and a schema member.
    // The bare name, not `defineMail(`: `defineMail<{ total: string }>({` is the usual spelling.
    { name: 'subject', whenFileContains: 'defineMail' },
  ],
} as const satisfies ExtractOptions;
