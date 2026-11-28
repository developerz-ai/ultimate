// `@ultimat3/ui/motion` — the one animation engine: the browser's WAAPI driven by the motion token
// scale. A subpath, not the barrel, on measurement (`scripts/ui-barrel-bytes.test.ts`): a barrel
// island pays nothing for it. Explicit exports only.

export type { SpringName } from '../tokens/tokens';
export { springs } from '../tokens/tokens';
export type { AnimateOptions, MotionFrame, MotionHandle, MotionLength } from './animate';
export { animate } from './animate';
export type { FrameLoopOptions } from './frame-loop';
export { frameLoop } from './frame-loop';
export type { InViewOptions } from './in-view';
export { inView } from './in-view';
export type { LayoutOptions } from './layout';
export { layout } from './layout';
export { motionAllowed, onMotionChange } from './motion-gate';
export type { MotionTiming } from './motion-timing';
export { motionTiming } from './motion-timing';
export type { PresenceProps, PresenceTag } from './Presence';
export { PRESENCE_ENTER, Presence } from './Presence';
export type { PresenceListProps } from './PresenceList';
export { PresenceList } from './PresenceList';
export type { PresencePhase } from './presence-view';
export type { ScrollLinkedOptions } from './scroll-linked';
export { scrollLinked } from './scroll-linked';
export type { SpringCurve, SpringSpec } from './spring-linear';
export { springLinear } from './spring-linear';
export type { StaggerOptions } from './stagger';
export { stagger } from './stagger';
