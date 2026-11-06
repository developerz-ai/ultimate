// The one edge that puts the global stylesheet in this app's module graph. `shared/` is loaded by
// both surfaces and by the framework's own boot scan, so the tokens reach every document without a
// page having to remember to import them — and `x verify` fails with X_STYLES_GLOBAL_MISSING if
// this edge is ever cut.

import './global.scss';
