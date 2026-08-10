import { afterEach, test as bunTest, describe, expect } from 'bun:test';
import { createTestNetwork } from './fixture-network';
import {
  isNetworkSealed,
  mockJson,
  networkState,
  resetNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';

// The gate is process-global and bun shares one process across files: a test that leaves the
// process offline takes every later file's fetch down with it.
afterEach(() => {
  resetNetwork();
  unsealNetwork();
});

const URL_UNDER_TEST = 'https://api.stripe.test/v1/charges';

describe('unit · the network fixture', () => {
  bunTest('offline fails the request the app’s offline path is written for', async () => {
    sealNetwork();
    const network = createTestNetwork();

    network.offline();

    await expect(fetch(URL_UNDER_TEST)).rejects.toBeUltimateError('X_TEST_NETWORK_OFFLINE');
    expect(network.state()).toBe('offline');
  });

  bunTest('online puts it back, and a mock answers again', async () => {
    sealNetwork();
    mockJson(URL_UNDER_TEST, { ok: true });
    const network = createTestNetwork();

    network.offline();
    await expect(fetch(URL_UNDER_TEST)).rejects.toBeUltimateError('X_TEST_NETWORK_OFFLINE');
    network.online();

    expect(await (await fetch(URL_UNDER_TEST)).json()).toEqual({ ok: true });
  });

  // The rule the offline gate sits ahead of the mocks for: a mock that still answered would be
  // the one thing the offline path never sees, and the test would pass without exercising it.
  bunTest('a mocked route is offline too — offline beats the mock', async () => {
    sealNetwork();
    mockJson(URL_UNDER_TEST, { ok: true });
    const network = createTestNetwork();

    network.offline();

    await expect(fetch(URL_UNDER_TEST)).rejects.toBeUltimateError('X_TEST_NETWORK_OFFLINE');
  });

  bunTest('drop is offline that names itself, so a resume is not a resubscribe', async () => {
    sealNetwork();
    const network = createTestNetwork();

    network.drop();

    expect(network.state()).toBe('dropped');
    await expect(fetch(URL_UNDER_TEST)).rejects.toBeUltimateError('X_TEST_NETWORK_OFFLINE');
  });

  // ULTIMATE_TEST_ALLOW_NET=1 unseals the process on purpose. `offline()` still has to bite there,
  // or a deliberate-integration file silently tests nothing when it goes offline.
  bunTest('offline works in an unsealed process, and hands the process back unsealed', () => {
    unsealNetwork();
    const network = createTestNetwork();

    network.offline();
    expect(isNetworkSealed()).toBe(true);

    network[Symbol.dispose]();

    expect(isNetworkSealed()).toBe(false);
    expect(networkState()).toBe('online');
  });

  bunTest('a sealed process stays sealed after disposal', () => {
    sealNetwork();
    const network = createTestNetwork();

    network.offline();
    network[Symbol.dispose]();

    expect(isNetworkSealed()).toBe(true);
    expect(networkState()).toBe('online');
  });

  // The leak this fixture would otherwise cause: bun shares one process across files, so an
  // offline left behind fails every later file at its first fetch, somewhere else entirely.
  bunTest('disposal puts the process back online even after drop', () => {
    sealNetwork();
    const network = createTestNetwork();

    network.drop();
    network[Symbol.dispose]();

    expect(networkState()).toBe('online');
  });
});
