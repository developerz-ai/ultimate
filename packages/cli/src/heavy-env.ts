// Every environment variable the machine ledger reads or sets, and the one reading of `CI`. A leaf:
// the worker planner and the error classes need these names without loading the ledger.

export type HeavyEnv = Readonly<Record<string, string | undefined>>;

/** The ledger's directory. Set by a test or an unusual machine; also opts a test run back in. */
export const HEAVY_DIR_ENV = 'ULTIMATE_HEAVY_DIR';
/** What the ledger admits in total (`8g`), replacing half of RAM. `0` turns it off. */
export const HEAVY_MEMORY_ENV = 'ULTIMATE_HEAVY_MEMORY';
/** The local core ceiling, replacing `LOCAL_CORE_CAP`. */
export const HEAVY_CORES_ENV = 'ULTIMATE_HEAVY_CORES';
/** Set on a holder's children: the reservation file they run inside. A protocol, not a knob. */
export const HEAVY_HOLD_ENV = 'ULTIMATE_HEAVY_HOLD';

/** A CI runner is single-tenant: nothing to queue behind, and every core is the run's. */
export const isCi = (env: HeavyEnv): boolean => {
  const value = env['CI'];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
};
