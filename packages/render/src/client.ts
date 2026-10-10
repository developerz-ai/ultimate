// `@ultimat3/render/client` — THE browser entry of this package: what an island or a page script
// may call, and nothing that drags the rest along. The `.` barrel bare-retains `errors.ts` (render's
// whole code table, registered at import, plus core's titles tables); this entry's graph is
// `navigation-api.ts`, `navigation-errors.ts`, `island-dispose.ts`, the pure rules and
// `@ultimat3/core/page`, held there by `client-bundle.test.ts`.
//
//   import { disposeIslands, navigate, openModal, refresh } from '@ultimat3/render/client';
//
// The same names stay exported from `.` for compatibility; an island imports them from here.

// An island that drops markup holding other islands releases them first: `disposeIslands(node)`.
export { disposeIslands } from './island-dispose';
export type { NavigateToOptions } from './navigation-api';
export { closeModal, navigate, openModal, refresh } from './navigation-api';
export { NavigationModalPathInvalidError } from './navigation-errors';
export { NAVIGATE_EVENT, NAVIGATED_EVENT, NAVIGATION_ERROR_EVENT } from './navigation-rules';
