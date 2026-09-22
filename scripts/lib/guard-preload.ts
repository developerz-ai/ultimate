// Preloaded by `package.json`'s guard scripts (`bun --preload ./scripts/lib/guard-preload.ts …`):
// the one way to catch a STATIC import that fails to link, since that happens before the guard's
// first line runs. See `guard-load.ts`.

import { installLoadGuard } from './guard-load';

installLoadGuard();
