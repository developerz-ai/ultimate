// `@ultimat3/render/navigation` — the client router's script, ONE classic script per opted-in
// document, built and served by `@ultimat3/cli` the way realtime's page boot is. Importing it IS
// starting it: a document that did not opt in carries no `ultimate-navigation` and is left alone.

import { startNavigation } from './navigation';

startNavigation();
