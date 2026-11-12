// `@ultimat3/render/client` — THE browser entry of this package: what an island or a page script
// may call, and nothing that drags the rest along. The `.` barrel bare-retains `errors.ts` (render's
// whole code table, registered at import, plus core's titles tables); this entry's graph is
// `navigation-api.ts`, `navigation-errors.ts`, `island-dispose.ts`, `island-mount.ts`,
// `refresh-idle.ts`, the pure rules and `@ultimat3/core/page`, held by `client-bundle.test.ts`.
//
//   import { navigate, refresh, scheduleRefresh } from '@ultimat3/render/client';
//
// The same names stay exported from `.` for compatibility; an island imports them from here.

// An island that drops markup holding other islands releases them first: `disposeIslands(node)`.
export { disposeIslands } from './island-dispose';
// An island's `mount` that keeps the server's markup when its render throws (`island-mount.ts`).
export type { IslandDraw } from './island-mount';
export { mountOver } from './island-mount';
export type { NavigateToOptions } from './navigation-api';
export { closeModal, navigate, openModal, refresh } from './navigation-api';
export { NavigationModalPathInvalidError } from './navigation-errors';
// What the router marks its modal `<dialog>` with: `dialog[${NAVIGATION_MODAL_ATTRIBUTE}]` in a style.
export { NAVIGATION_MODAL_ATTRIBUTE } from './navigation-modal-rules';
export { NAVIGATE_EVENT, NAVIGATED_EVENT, NAVIGATION_ERROR_EVENT } from './navigation-rules';
// A channel said the page changed: re-read it once the visitor is idle (`refresh-idle.ts`).
export { scheduleRefresh } from './refresh-idle';
