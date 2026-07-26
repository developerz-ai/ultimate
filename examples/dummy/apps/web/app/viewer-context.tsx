/**
 * The viewer (locale + IANA zone) as a context, so a component three levels down renders a date
 * in the right zone without every page threading a prop. One provider, in `layout.tsx`.
 */

import { createContext, type JSX, useContext } from 'solid-js';
import type { Viewer } from '../shared/viewer';
import { anonymousViewer } from '../shared/viewer';

const ViewerContext = createContext<Viewer>(anonymousViewer({}));

export const ViewerProvider = (props: {
  readonly value: Viewer;
  readonly children: JSX.Element;
}): JSX.Element => (
  <ViewerContext.Provider value={props.value}>{props.children}</ViewerContext.Provider>
);

/** Never falls back to the server's zone — the default is UTC, which is at least honest. */
export const useViewer = (): Viewer => useContext(ViewerContext);
