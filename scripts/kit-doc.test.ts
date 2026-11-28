// `wiki/Agents.md`'s kit table is generated from `kit/registry.ts`, and `--check` refuses a page that
// no longer says what the registry says.

import { describe, expect, test } from 'bun:test';
import { KIT_ENTRIES } from '../packages/cli/src/kit/registry';
import {
  KIT_BEGIN,
  KIT_END,
  KIT_PAGE,
  kitDocFindings,
  renderKitTable,
  spliceKitTable,
} from './kit-doc';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

describe('unit · kit-doc', () => {
  test('one row per registry entry, in the registry’s order, each naming its path', () => {
    const rows = renderKitTable()
      .split('\n')
      .filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(KIT_ENTRIES.length);
    KIT_ENTRIES.forEach((entry, index) => {
      expect(rows[index]).toContain(`\`${entry.name}\``);
      expect(rows[index]).toContain(`\`${entry.path}\``);
    });
  });

  test('a row says what the entry is for, from its own description, never a blank', () => {
    for (const row of renderKitTable()
      .split('\n')
      .filter((line) => line.startsWith('| `'))) {
      expect(row.split('|')[4]?.trim().length ?? 0).toBeGreaterThan(20);
    }
  });

  test('splicing replaces the marked region and nothing around it', () => {
    const page = `before\n${KIT_BEGIN}\nstale\n${KIT_END}\nafter\n`;
    const next = spliceKitTable(page);
    expect(next?.startsWith('before\n')).toBe(true);
    expect(next?.endsWith('\nafter\n')).toBe(true);
    expect(next).not.toContain('stale');
    expect(spliceKitTable(next ?? '')).toBe(next);
  });

  test('a page with no markers cannot be spliced', () => {
    expect(spliceKitTable('no markers here')).toBeUndefined();
  });

  test(
    'the committed page matches the registry',
    async () => {
      expect(await kitDocFindings(repoRoot())).toEqual([]);
      expect(await Bun.file(`${repoRoot()}/${KIT_PAGE}`).text()).toContain(KIT_BEGIN);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
