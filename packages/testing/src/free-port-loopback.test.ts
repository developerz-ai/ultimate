// `loopbackFree` against the real OS: a port held on a loopback address is not free there, a port
// nothing holds is, and an address this host does not have holds nothing.

import { describe, expect, test } from 'bun:test';
import { loopbackFree } from './free-port';

describe('loopbackFree', () => {
  test('a port held on 127.0.0.1 is not free; released, it is', () => {
    const holder = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const port = holder.port;
    try {
      expect(loopbackFree(port, ['127.0.0.1'])).toBe(false);
    } finally {
      holder.stop(true);
    }
    expect(loopbackFree(port, ['127.0.0.1'])).toBe(true);
  });

  test('an address that is no address here holds nothing, so it does not refuse the port', () => {
    const holder = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const port = holder.port;
    holder.stop(true);
    // TEST-NET-1: routable syntax, assigned to no interface on this host — EADDRNOTAVAIL.
    expect(loopbackFree(port, ['192.0.2.1'])).toBe(true);
  });
});
