// The `network` fixture: pull the cable, put back exactly what was there. What an offline test
// needs is not a mock that answers differently — it is a request that fails the way a real one
// fails, so the app's own offline path runs instead of a branch written for the test.

import {
  isNetworkSealed,
  type NetworkState,
  networkState,
  sealNetwork,
  setNetworkState,
  unsealNetwork,
} from './sealed-network';

/** `Disposable`: the gate is process-global, so the fixture puts back the state it found. */
export interface TestNetwork extends Disposable {
  /** Every request fails as it would with no route to the host. */
  offline(): void;
  /**
   * Offline, and the connection was cut rather than closed — a subscriber must reconnect.
   * Next to `offline()` because the two are different bugs: a clean offline is what a service
   * worker answers, and a fixture with only one of them cannot tell a resume from a resubscribe.
   */
  drop(): void;
  online(): void;
  state(): NetworkState;
}

/**
 * Synchronous, unlike `mail` and `runJobs`: the gate it drives lives in this package, so there is
 * no subsystem to import on demand. The test bodies rely on it — `network.offline()` is followed
 * on the next line by the mutation that has to observe it.
 */
export function createTestNetwork(): TestNetwork {
  // A process that unsealed on purpose (ULTIMATE_TEST_ALLOW_NET=1) still gets a working
  // `offline()`, and gets its unsealed fetch back on disposal rather than keeping ours.
  const sealedBefore = isNetworkSealed();
  // Both halves of what was here, because disposal restores rather than assumes. An outer fixture
  // already offline must not come back online because an inner one finished.
  const stateBefore = networkState();
  let sealedByUs = false;

  const goto = (next: NetworkState): void => {
    if (next !== 'online' && !isNetworkSealed()) {
      sealNetwork();
      sealedByUs = true;
    }
    setNetworkState(next);
  };

  return {
    offline: () => goto('offline'),
    drop: () => goto('dropped'),
    online: () => goto('online'),
    state: networkState,
    [Symbol.dispose]: (): void => {
      setNetworkState(stateBefore);
      if (sealedByUs && !sealedBefore) unsealNetwork();
      sealedByUs = false;
    },
  };
}
