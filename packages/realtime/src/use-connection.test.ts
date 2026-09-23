// `useConnection`: the page socket as getters that stay live, and the honest server-render answer.
// `hasPageSocket` is the guard a component with a static fallback asks instead.

import { afterEach, describe, expect, test } from 'bun:test';
import { pageHarness, resetPage } from './hooks-fixture';
import { hasPageSocket } from './page-store';
import { PROTOCOL_VERSION } from './sync-protocol';
import { useConnection } from './use-connection';

afterEach(() => {
  resetPage();
});

describe('useConnection', () => {
  test('getters, not a snapshot: one read object follows the socket up and down', () => {
    const { socket } = pageHarness();
    const connection = useConnection();
    expect(connection.offline).toBe(true);
    socket.open();
    expect(connection.online).toBe(true);
    socket.close(1006);
    expect(connection.offline).toBe(true);
  });

  test('a newer build announced by the node reads through', () => {
    const { socket } = pageHarness();
    socket.open();
    const connection = useConnection();
    expect(connection.updateAvailable).toBeNull();
    socket.deliver({ type: 'update-available', v: PROTOCOL_VERSION, buildId: 'build-2' });
    expect(connection.updateAvailable).toBe('build-2');
  });

  test('reconnectAt is the armed redial while the socket is down, and null while up', () => {
    const { socket, client } = pageHarness();
    socket.open();
    const connection = useConnection();
    expect(connection.reconnectAt).toBeNull();
    socket.close(1006);
    expect(connection.reconnectAt).toBe(client.reconnectAt());
    expect(typeof connection.reconnectAt).toBe('number');
  });

  test('a server render is online and opens no socket', () => {
    resetPage();
    expect(useConnection().online).toBe(true);
    expect(hasPageSocket()).toBe(false);
  });

  test('hasPageSocket is true once the page holds one', () => {
    pageHarness();
    expect(hasPageSocket()).toBe(true);
  });
});
