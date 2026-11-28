// Single responsibility: the `@ultimat3/core/outbound` entry — the outbound call, the dial screen,
// the undoable deadline signal and the boot's app-wide proxy installer, and nothing else. A
// subpath, never the barrel: core is in every bundle graph and this reads `Bun.dns` (axiom 6).
// `outbound-subpath.test.ts` pins the split.

export type { DeadlineSignal, DeadlineTimer } from './deadline-signal';
export { deadlineSignal, platformDeadlineTimer } from './deadline-signal';
export { outbound, outboundResponse } from './outbound';
export type { OutboundProxyConfig } from './outbound-default-proxy';
export { ambientProxyFor, configureOutboundProxy } from './outbound-default-proxy';
export type { DialPin, DialResolve, DialVerdict, ScreenDialOptions } from './outbound-dial';
export { publicUrlRefusal, resolveDialHost, screenDial } from './outbound-dial';
export type { OutboundSite, OutboundTimeoutPhase } from './outbound-errors';
export type {
  OutboundAnswer,
  OutboundBody,
  OutboundDeps,
  OutboundFetch,
  OutboundInit,
  OutboundMethod,
  OutboundProxy,
  OutboundProxyInit,
  OutboundProxyTarget,
  OutboundRefusalRead,
  OutboundRequest,
  OutboundStreamAnswer,
} from './outbound-types';
export {
  OUTBOUND_IDLE_MS,
  OUTBOUND_MAX_BYTES,
  OUTBOUND_MAX_REDIRECTS,
  OUTBOUND_RETRY,
} from './outbound-types';
