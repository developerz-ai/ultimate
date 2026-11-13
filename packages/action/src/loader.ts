// `@ultimat3/action/loader` — where an export is NAMED as an action: `x`'s module scan and the
// framework's own fixtures. Never the `.` barrel: an app hands its modules to `defineApi`, the one
// registration path (axiom 1), and that reaches these through the same registry.

// `restoreActions` is test-only, and here for the reason the other two are: it writes the registry.
// `@ultimat3/testing`'s rerun seam hands back what `listActions()` read, through `registerAction`.
export { registerAction, registerActions, restoreActions } from './registry';
