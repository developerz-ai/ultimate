// One name, one barrel. The client/server split only holds if a name lives in exactly one of them:
// re-exporting `openNatsClient` from `index.ts` "for convenience" is how the browser island breaks
// again, and a duplicate is invisible to `tsc` because both spellings resolve to one module.
// Types are checked off the SOURCE, since a type-only export leaves no runtime namespace entry.

import { describe, expect, test } from 'bun:test';
import * as client from './index';
import * as server from './server';

const barrelSource = async (file: 'index' | 'server'): Promise<string> =>
  await Bun.file(`${import.meta.dir}/${file}.ts`).text();

/**
 * Every name a barrel re-exports, types included. The barrels are mechanical `export { … } from`
 * blocks, so the brace contents are the whole surface — `export *` is banned repo-wide, which is
 * what makes reading the braces total rather than a guess.
 *
 * The PUBLIC name, which for `export { Local as Public }` is the half after `as`. Reading the
 * local one instead is how a duplicate hides: two barrels exporting different types under one
 * `Public` record two different source names here and pass, and the value check above cannot see
 * them either, because a type-only export leaves no runtime namespace entry to collide.
 */
function declaredNames(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const raw of (block[1] ?? '').split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe('realtime barrels', () => {
  test('no value is exported from both entries', () => {
    const shared = Object.keys(client).filter((name) => name in server);
    expect(shared).toEqual([]);
  });

  test('no declared name — types included — is exported from both entries', async () => {
    const clientNames = declaredNames(await barrelSource('index'));
    const serverNames = declaredNames(await barrelSource('server'));
    expect(clientNames.size).toBeGreaterThan(50);
    expect(serverNames.size).toBeGreaterThan(50);
    expect([...clientNames].filter((name) => serverNames.has(name))).toEqual([]);
  });

  test('the client entry carries the hook and the wire, and neither the bus nor the WAL', () => {
    expect(client.useLive).toBeTypeOf('function');
    expect(client.liveHookFor).toBeTypeOf('function');
    expect(client.decode).toBeTypeOf('function');
    for (const name of ['openNatsClient', 'bunPgStream', 'NatsTransport', 'createSyncNode']) {
      expect(Object.keys(client)).not.toContain(name);
    }
  });

  test('the server entry carries the bus, the WAL and the node', () => {
    expect(server.openNatsClient).toBeTypeOf('function');
    expect(server.bunPgStream).toBeTypeOf('function');
    expect(server.NatsTransport).toBeTypeOf('function');
    expect(server.createSyncNode).toBeTypeOf('function');
  });
});
