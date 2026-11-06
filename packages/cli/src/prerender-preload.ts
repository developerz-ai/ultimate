// Preloaded into `x build --target static`'s `bun run apps/web/prerender.ts`: installs the render
// loader BEFORE Bun parses the script's import graph. A `.tsx` the script reaches statically (a
// shared module that imports `@ultimat3/ui`) is parsed first, so a loader installed by evaluating
// `@ultimat3/render` inside that graph arrives too late and Bun compiles the JSX to `jsxDEV`.

import '@ultimat3/render/server';
