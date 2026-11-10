// The `mcpConfirmationStore` port: `mcpConfirmations({ store })` may omit the store, and then keeps
// its rows in the one the boot installed from `runtime.ts` — else Postgres over the app's pool.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import * as adapter from './adapter';
import {
  installConfirmationStore,
  installedConfirmationStore,
  resetConfirmationStore,
} from './confirmation-installed';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';
import * as barrel from './index';

afterEach(() => {
  resetConfirmationStore();
  resetActions();
});

const build = (store?: ReturnType<typeof memoryConfirmationStore>) =>
  mcpConfirmations({
    tools: ['refundOrder'],
    permission: 'order:refund',
    ...(store === undefined ? {} : { store }),
  });

describe('unit · the installed confirmation store', () => {
  test('a declaration naming no store keeps its rows in the installed one', () => {
    const store = memoryConfirmationStore();
    installConfirmationStore(store);
    expect(build().store).toBe(store);
  });

  // The declaration is imported before the boot installs `runtime.mcpConfirmationStore`: read per use.
  test('a declaration built before the install keeps its rows in the store installed after it', () => {
    const confirmations = build();
    const store = memoryConfirmationStore();
    installConfirmationStore(store);
    expect(confirmations.store).toBe(store);
  });

  test("the app's own store wins over the installed one", () => {
    installConfirmationStore(memoryConfirmationStore());
    const mine = memoryConfirmationStore();
    expect(build(mine).store).toBe(mine);
  });

  test('a release removes its own install only, in any order', () => {
    const first = memoryConfirmationStore();
    const second = memoryConfirmationStore();
    const releaseFirst = installConfirmationStore(first);
    const releaseSecond = installConfirmationStore(second);
    releaseFirst();
    expect(installedConfirmationStore()).toBe(second);
    releaseSecond();
    expect(installedConfirmationStore()).not.toBe(second);
  });

  test('nothing installed is the env default: a store, never undefined', () => {
    expect(typeof installedConfirmationStore().open).toBe('function');
  });

  test('the installer is on ./adapter only', () => {
    expect(adapter.installConfirmationStore).toBe(installConfirmationStore);
    expect(adapter.resetConfirmationStore).toBe(resetConfirmationStore);
    expect(Object.keys(barrel)).not.toContain('installConfirmationStore');
  });
});
