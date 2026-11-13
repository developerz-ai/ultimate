// The held-timer half of the router's fake window (`navigation-dom-fixture.ts`): a delayed timer
// waits for `advance(ms)`, so the test moves time and nothing races a real one. `holdTimers()`
// RETURNS this clock, so advancing time never held is unwritable rather than a runtime refusal.
// A zero delay still runs on the loop; held ids are negative, never mistaken for a real one.

interface HeldTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** The clock a held window's delayed timers wait on. */
export class HeldTimers {
  private readonly held: HeldTimer[] = [];
  private now = 0;
  private lastId = 0;

  /** Holds `fn` for `delay` ms of test time and answers its (negative) id. */
  hold(fn: () => void, delay: number): number {
    this.lastId -= 1;
    this.held.push({ id: this.lastId, at: this.now + delay, fn });
    return this.lastId;
  }

  /** Drops a held timer; false when `id` is not one, so the caller clears a real timer instead. */
  clear(id: number | undefined): boolean {
    const at = this.held.findIndex((timer) => timer.id === id);
    if (at < 0) return false;
    this.held.splice(at, 1);
    return true;
  }

  /** Fires, in due order, every held timer due within `ms` — one armed while firing included. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.held.reduce<HeldTimer | undefined>(
        (soonest, timer) =>
          timer.at <= until && (soonest === undefined || timer.at < soonest.at) ? timer : soonest,
        undefined,
      );
      if (next === undefined) break;
      this.held.splice(this.held.indexOf(next), 1);
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }
}
