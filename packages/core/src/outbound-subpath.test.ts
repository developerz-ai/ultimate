// `outbound()` and `screenDial` ride `@ultimat3/core/outbound` and never the barrel: core is in every
// bundle graph, and the dial screen reads `Bun.dns`, which a page must not pay for (axiom 6).

import { describe, expect, test } from 'bun:test';
import corePackage from '../package.json';
import * as barrel from './index';
import * as subpath from './outbound-subpath';

describe('unit · @ultimat3/core/outbound', () => {
  test('the barrel exports no outbound name; the subpath exports the call and the screen', () => {
    const names = Object.keys(barrel);
    for (const name of ['outbound', 'screenDial', 'resolveDialHost', 'deadlineSignal']) {
      expect(names).not.toContain(name);
    }
    expect(typeof subpath.outbound).toBe('function');
    expect(typeof subpath.screenDial).toBe('function');
    expect(typeof subpath.deadlineSignal).toBe('function');
  });

  test('the package exports the subpath at that one file', () => {
    expect(corePackage.exports['./outbound']).toBe('./src/outbound-subpath.ts');
  });
});
