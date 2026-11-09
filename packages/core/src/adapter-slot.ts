// Single responsibility: the ONE installed-value slot every adapter port uses. A stack of frames,
// each removed only by its own release, so installers may stop in any order: the shape
// `@ultimat3/http`'s rate-limit slot and `@ultimat3/realtime`'s channel transport proved, here once.
// Imports nothing — safe in any bundle graph.

export interface AdapterSlot<T> {
  /**
   * Push `value` as a new frame. Answers the release, which removes THIS frame and no other —
   * idempotent, and harmless after any later install or a `reset()`.
   */
  install(value: T): () => void;
  /** The newest installed value, or the fallback (read at this call) when nothing is installed. */
  current(): T;
  /** Drop every frame. A test seam: production releases what it installed. */
  reset(): void;
}

/**
 * `slot = previous` is what this replaces: boot A installs, boot B installs, A stops first and the
 * slot reverts under B while B still serves; B's release later restores A's stopped value. A frame
 * object is its own identity, so the same value installed twice is two frames.
 */
export function adapterSlot<T>(fallback: () => T): AdapterSlot<T> {
  const frames: { readonly value: T }[] = [];
  return {
    install(value: T): () => void {
      const frame = { value };
      frames.push(frame);
      return () => {
        const at = frames.indexOf(frame);
        if (at !== -1) frames.splice(at, 1);
      };
    },
    current(): T {
      const top = frames.at(-1);
      return top === undefined ? fallback() : top.value;
    },
    reset(): void {
      frames.length = 0;
    },
  };
}
