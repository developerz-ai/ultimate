// The catalog's composition: `messages.ts` spreads its per-family files into one object. A base key
// a family file repeats is a type error (TS2783); two family files repeating one key is not — a
// later spread silently wins — so that overlap is asserted here.

import { describe, expect, test } from 'bun:test';
import { messageKeys, msg } from './messages';
import { DB_MESSAGES } from './messages-db';
import { GATE_MESSAGES } from './messages-gate';
import { SHOT_MESSAGES } from './messages-shot';
import { UPGRADE_MESSAGES } from './messages-upgrade';

const PARTS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map<
  string,
  Readonly<Record<string, string>>
>([
  ['messages-db.ts', DB_MESSAGES],
  ['messages-gate.ts', GATE_MESSAGES],
  ['messages-shot.ts', SHOT_MESSAGES],
  ['messages-upgrade.ts', UPGRADE_MESSAGES],
]);

describe('the CLI catalog', () => {
  test('no key is declared in two catalog files', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const [file, part] of PARTS) {
      for (const key of Object.keys(part)) {
        const first = owner.get(key);
        if (first !== undefined) clashes.push(`${key}: ${first} and ${file}`);
        owner.set(key, file);
      }
    }
    expect(clashes).toEqual([]);
  });

  test('every family file is composed into the one lookup', () => {
    const keys = messageKeys();
    for (const part of PARTS.values()) {
      for (const [key, template] of Object.entries(part)) {
        expect(keys).toContain(key);
        expect(msg(key)).toBe(template);
      }
    }
  });

  test('a miss renders loudly and placeholders interpolate', () => {
    expect(msg('cli.no.such.key')).toBe('⟦cli.no.such.key⟧');
    expect(msg('cli.db.branch.ready', { name: 'feat' })).toBe('branch feat ready');
    expect(msg('cli.db.branch.ready')).toBe('branch {name} ready');
  });
});
