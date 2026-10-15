// Server truth that must wait for the page's own writes before it lands (#778): a channel's
// catch-up read whose snapshot may already hold a write still in flight. Adopted under that write's
// twin it is the write counted twice, so it lands once nothing blocks it — or when the store's one
// server-wait bound passes, and then exactly as it always did.

/** A held landing. `recheck` asks again now, for what changed outside the store (a held echo). */
export interface HeldLanding {
  recheck(): void;
}

interface Held {
  readonly blocked: () => boolean;
  fire(): void;
}

const LANDED: HeldLanding = { recheck: () => undefined };

export class Landings {
  readonly #held = new Set<Held>();
  readonly #bound: (fire: () => void) => () => void;
  readonly #report: (error: unknown) => void;

  /**
   * `bound` arms the ceiling on one hold: the store's server wait, never a second number. A held
   * landing runs inside whatever batch released it, so what it throws is `report`ed, never raised
   * into that unrelated caller (a write's settle) or left to stop the landings behind it.
   */
  constructor(bound: (fire: () => void) => () => void, report: (error: unknown) => void) {
    this.#bound = bound;
    this.#report = report;
  }

  /** `land` runs at once when nothing blocks it; otherwise at the first check that finds none. */
  hold(blocked: () => boolean, land: () => void): HeldLanding {
    if (!blocked()) {
      land();
      return LANDED;
    }
    let done = false;
    let cancel = (): void => undefined;
    const held: Held = {
      blocked,
      fire: () => {
        if (done) return;
        done = true;
        this.#held.delete(held);
        cancel();
        try {
          land();
        } catch (error) {
          this.#report(error);
        }
      },
    };
    this.#held.add(held);
    cancel = this.#bound(() => held.fire());
    return {
      recheck: () => {
        if (!done && !blocked()) held.fire();
      },
    };
  }

  /** After every store notification: whatever nothing blocks any longer lands, in hold order. */
  check(): void {
    if (this.#held.size === 0) return;
    for (const held of [...this.#held]) if (!held.blocked()) held.fire();
  }
}
