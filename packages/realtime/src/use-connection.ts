// The page socket, as four getters: whether it is up, when it redials, and whether a newer build
// is live. Getters, never a snapshot, so a read inside a tracking scope stays live. Asking opens
// the socket — this hook IS a question about it.

import { pageSocket } from './page-socket';
import { isServerRender, signalFor } from './reactivity';

export interface Connection extends Disposable {
  /** Stop listening to the socket (Solid: `onCleanup`). The socket itself stays up. */
  release(): void;
  readonly offline: boolean;
  readonly online: boolean;
  /** Epoch ms of the next reconnect attempt; `null` while the socket is up. */
  readonly reconnectAt: number | null;
  /** The buildId the server announced, or `null` while this build is current. */
  readonly updateAvailable: string | null;
}

/**
 * A server render is ONLINE: the banner is about this visitor's connectivity, and the request
 * being served is the proof it is up. Answering offline would render "you are offline" into every
 * document and remove it on hydrate.
 */
const SERVER_RENDER: Connection = Object.freeze({
  release: (): void => undefined,
  [Symbol.dispose]: (): void => undefined,
  offline: false,
  online: true,
  reconnectAt: null,
  updateAvailable: null,
});

export function useConnection(): Connection {
  const signal = signalFor('useConnection');
  if (isServerRender()) return SERVER_RENDER;
  const client = pageSocket('useConnection');
  const [version, setVersion] = signal(0);
  const release = client.onStatus(() => setVersion(version() + 1));
  return {
    release,
    [Symbol.dispose]: release,
    get offline() {
      version();
      return !client.connected;
    },
    get online() {
      version();
      return client.connected;
    },
    get reconnectAt() {
      version();
      return client.reconnectAt();
    },
    get updateAvailable() {
      version();
      return client.appUpdateAvailable();
    },
  };
}
