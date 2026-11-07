// The states the search island can be photographed in. `x shot --island search --json` takes one
// picture per state. PURE DATA: the one import is `import type`.

import { defineIslandStates } from '@ultimat3/testing';
import type { SearchIslandProps } from './search.island';

export const searchStates = defineIslandStates({
  island: 'apps/web/site/search/search.island.tsx',
  states: [
    {
      id: 'default',
      title: 'the empty search form, before a query',
      props: {
        indexPath: '/search-index.json',
        loadingLabel: 'Loading the index…',
        emptyLabel: 'Nothing matched.',
        failedLabel: 'The search index could not be loaded.',
      } satisfies SearchIslandProps,
    },
  ],
});
