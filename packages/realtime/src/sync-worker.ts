// The SharedWorker entry (plan 101, slice 11): every tab of this origin and principal connects a
// port, and the one engine behind them holds the one socket. `x build` bundles this file as a
// classic script at `/_x/sync-worker/<hash>.js`. No other code lives here.

import { browserSocket, dialUrl } from './browser-socket';
import { messagePort, SocketEngine } from './socket-engine';

const engine = new SocketEngine({ dial: (target) => browserSocket(dialUrl(target)) });

(globalThis as { onconnect?: (event: MessageEvent) => void }).onconnect = (event) => {
  for (const port of event.ports) engine.attach(messagePort(port));
};
