// Single responsibility: the `@ultimat3/realtime/adapter` entry — what a bus driver implements and
// throws, and the installer the boot (and `@ultimat3/testing`'s override seam) puts it in with. An
// app never imports this: it hands its `Transport` to `apps/<app>/runtime.ts`'s `transport`.
// Never re-exported from `.` or `./server` (`barrel-split.test.ts`).

export { installChannelTransport } from './channel-publish';
export { TransportProtocolError, TransportUnavailableError } from './errors';
export type {
  Transport,
  TransportHandler,
  TransportSet,
  TransportSetEntry,
  TransportSubscription,
} from './fanout';
