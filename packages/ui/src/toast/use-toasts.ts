// The reactive shell over `createToastStore`, and the whole of what it adds: the queue lands in a
// signal, so `<Toaster>` re-renders when a message arrives or a dwell runs out.
//
// The subscription lives in an EFFECT, which is the package's one seam for DOM-only work: a server
// render never runs it, so the store is never subscribed to on a path where no timer can fire and
// the region renders empty — which is exactly what a document needs to carry before the first
// message, since a live region created with its content already inside it is not announced.

import { solid } from '../theme/solid-adapter';
import type { ToastQueue } from './toast-state';
import type { ToastStore } from './toast-store';

export function useToasts(store: ToastStore): () => ToastQueue {
  const runtime = solid();
  const [queue, setQueue] = runtime.createSignal<ToastQueue>(store.queue());

  runtime.createEffect(() => {
    const unsubscribe = store.subscribe(setQueue);
    // A toast shown between the render and this effect would otherwise never be seen: the signal
    // holds the queue as it was when the component body ran.
    setQueue(store.queue());
    runtime.onCleanup(unsubscribe);
  });

  return queue;
}
