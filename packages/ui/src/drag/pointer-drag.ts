// The one drag gesture: Pointer Events with capture, never HTML5 drag events (they do not fire on
// touch and have no keyboard form). A pure tracker decides tap vs drag and cancel; the binder wires
// it to a handle; the auto-scroller steps a box near its edges. Clock and geometry are injected.

/** A pointer position in client coordinates. */
export interface DragPoint {
  readonly x: number;
  readonly y: number;
}

/** Below this travel a press is a tap: a click on the handle, never a lift. */
export const DRAG_THRESHOLD_PX = 4;

export interface DragHandlers {
  /** The travel passed the threshold: the item lifts at the press point. */
  start(origin: DragPoint): void;
  move(point: DragPoint): void;
  drop(point: DragPoint): void;
  /** Escape, `pointercancel`, a lost capture or a blur: back to the origin, nothing requested. */
  cancel(): void;
}

export type DragPhase = 'idle' | 'pressed' | 'dragging';

export interface DragTracker {
  phase(): DragPhase;
  down(point: DragPoint): void;
  move(point: DragPoint): void;
  up(point: DragPoint): void;
  cancel(): void;
}

/** The state machine alone, so a test drives tap, drag, drop and every cancel with plain points. */
export function dragTracker(handlers: DragHandlers, threshold = DRAG_THRESHOLD_PX): DragTracker {
  let phase: DragPhase = 'idle';
  let origin: DragPoint = { x: 0, y: 0 };
  return {
    phase: () => phase,
    down(point) {
      phase = 'pressed';
      origin = point;
    },
    move(point) {
      if (phase === 'pressed') {
        if (Math.hypot(point.x - origin.x, point.y - origin.y) < threshold) return;
        phase = 'dragging';
        handlers.start(origin);
      }
      if (phase === 'dragging') handlers.move(point);
    },
    up(point) {
      const was = phase;
      phase = 'idle';
      if (was === 'dragging') handlers.drop(point);
    },
    cancel() {
      const was = phase;
      phase = 'idle';
      if (was === 'dragging') handlers.cancel();
    },
  };
}

/** The edge band, in px, inside which a drag scrolls its box, and the cap on a frame's step. */
export const AUTO_SCROLL_EDGE_PX = 48;
export const AUTO_SCROLL_MAX_PX = 16;

/**
 * Px per frame along one axis for a pointer at `pos` in a box spanning `lo..hi`: zero in the
 * middle, growing toward an edge, capped. Under reduced motion there is no ramp — one whole step
 * of `edge` px, which the scroller spends on a slow cadence instead of every frame.
 */
export function autoScrollDelta(pos: number, lo: number, hi: number, reduced: boolean): number {
  const edge = Math.min(AUTO_SCROLL_EDGE_PX, (hi - lo) / 2);
  if (edge <= 0) return 0;
  const into = pos < lo + edge ? -(lo + edge - pos) : pos > hi - edge ? pos - (hi - edge) : 0;
  if (into === 0) return 0;
  if (reduced) return Math.sign(into) * AUTO_SCROLL_EDGE_PX;
  return (
    Math.sign(into) *
    Math.min(AUTO_SCROLL_MAX_PX, Math.ceil((Math.abs(into) / edge) * AUTO_SCROLL_MAX_PX))
  );
}

/** The host a scroller needs: a frame clock and a reduced-motion answer, both injected. */
export interface ScrollEnv {
  frame(run: () => void): number;
  cancelFrame(handle: number): void;
  now(): number;
  reducedMotion(): boolean;
}

/** Under reduced motion the box moves in steps this far apart, never as a glide. */
export const REDUCED_STEP_MS = 250;

export interface Scrollable {
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number };
  scrollBy(x: number, y: number): void;
}

/** Scrolls `box` while the last pointer sits in an edge band; `stop()` ends it for good. */
export function autoScroller(
  env: ScrollEnv,
  box: Scrollable,
): { update(point: DragPoint): void; stop(): void } {
  let point: DragPoint | null = null;
  let handle: number | null = null;
  let last = Number.NEGATIVE_INFINITY;
  const tick = (): void => {
    handle = null;
    if (point === null) return;
    const rect = box.getBoundingClientRect();
    const reduced = env.reducedMotion();
    const dx = autoScrollDelta(point.x, rect.left, rect.right, reduced);
    const dy = autoScrollDelta(point.y, rect.top, rect.bottom, reduced);
    if (dx === 0 && dy === 0) return;
    if (!reduced || env.now() - last >= REDUCED_STEP_MS) {
      last = env.now();
      box.scrollBy(dx, dy);
    }
    handle = env.frame(tick);
  };
  return {
    update(next) {
      point = next;
      if (handle === null) handle = env.frame(tick);
    },
    stop() {
      point = null;
      if (handle !== null) env.cancelFrame(handle);
      handle = null;
    },
  };
}

/** The browser's frame clock, read only when a drag starts — a server render never gets here. */
export function browserScrollEnv(): ScrollEnv {
  return {
    frame: (run) => requestAnimationFrame(run),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    now: () => performance.now(),
    reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

const pointOf = (event: PointerEvent): DragPoint => ({ x: event.clientX, y: event.clientY });

/**
 * Wires a tracker to one handle: the press captures the pointer, so the move, the release and the
 * cancel arrive here wherever the finger goes. Primary button only. Answers the unbind.
 */
export function bindPointerDrag(handle: HTMLElement, handlers: DragHandlers): () => void {
  const tracker = dragTracker(handlers);
  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    tracker.down(pointOf(event));
    handle.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent): void => {
    if (tracker.phase() === 'idle') return;
    tracker.move(pointOf(event));
    if (tracker.phase() === 'dragging') event.preventDefault();
  };
  const onUp = (event: PointerEvent): void => tracker.up(pointOf(event));
  const onCancel = (): void => tracker.cancel();
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && tracker.phase() === 'dragging') tracker.cancel();
  };
  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  handle.addEventListener('lostpointercapture', onCancel);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onCancel);
  return () => {
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    handle.removeEventListener('lostpointercapture', onCancel);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onCancel);
  };
}
