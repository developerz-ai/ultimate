// Whether the header should render its signed-in half.
//
// `currentViewer()` is the app's one answer to "who is this", and this defers to it rather than
// re-deriving one — a second reader of `ctx.actor` is a second place the shell and a policy can
// disagree. The only thing added is the off-request case: `useContext()` throws X_NO_CONTEXT when
// there is no request at all (a build-time prerender, a unit test), and "nobody" is the right
// answer for an artifact that is then served to everyone.

import { tryUseContext } from '@ultimat3/core';
import { currentViewer, isSignedIn } from '../actor';

export const viewerIsSignedIn = (): boolean =>
  tryUseContext() !== undefined && isSignedIn(currentViewer());
