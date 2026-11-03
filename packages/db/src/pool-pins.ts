// Single responsibility: which statements are in flight on each pin a pool holds, so an acquire
// refusal can tell a gate full of dead transactions from a busy one. A pin is never swept on its own
// (`SET LOCAL` may raise its bound); only when EVERY slot is a pin past the bound is the path dead.

/** One statement on a pin, as the sweep counts it. */
export interface PinStatement {
  overdue(): boolean;
  done(): void;
}

/** The statements in flight on ONE pin. */
export type PinRecord = Set<PinStatement>;

/** `sending` counted on `record` until it settles. No sweep (`statementTimeoutMs: 0`): not counted. */
export function onPin<T>(
  record: PinRecord,
  watch: (() => PinStatement) | undefined,
  sending: () => Promise<T>,
): Promise<T> {
  if (watch === undefined) return sending();
  const statement = watch();
  record.add(statement);
  const settle = (): void => {
    statement.done();
    record.delete(statement);
  };
  return sending().finally(settle);
}

/**
 * True only when the pins alone fill the gate and each has a statement past the bound. An idle pin,
 * a pin still in time, or a slot held by a plain statement (which the sweep judges itself) is a
 * pool that is busy, not gone.
 */
export function pinsWedged(pins: ReadonlySet<PinRecord>, max: number): boolean {
  if (pins.size < max) return false;
  for (const statements of pins) {
    let overdue = false;
    for (const statement of statements) {
      if (statement.overdue()) {
        overdue = true;
        break;
      }
    }
    if (!overdue) return false;
  }
  return true;
}
