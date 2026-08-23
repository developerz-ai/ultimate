// The scanner's contract: it reads what is installed and invents nothing. Every failure case
// here is a way a scan could hand an agent a doc entry that does not correspond to shipped code.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledDocs, scanPackageDocs } from './docs-scan';

function fixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-docs-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('unit · scanPackageDocs', () => {
  test('a directory with no package.json yields nothing and does not throw', async () => {
    const dir = fixture({ 'src/index.ts': "export { a } from './a';" });
    expect(await scanPackageDocs(dir)).toEqual([]);
  });

  test('a re-export from another package does not become a local module entry', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/jobs"}',
      'src/index.ts': "export { t } from '@ultimat3/schema';\nexport { job } from './job';",
      'src/job.ts': '// Durable background work.\nexport function job() {}',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries.map((entry) => entry.topic)).toEqual(['jobs.job']);
    expect(entries[0]?.symbols).toEqual(['job']);
  });

  // @ultimat3/ui ships ~40 components as .tsx. Resolving only `.ts` indexed none of them, so a
  // shipped command was blind to a whole package — and silently, because a missing file is a skip.
  test('a .tsx module is indexed, not skipped as missing', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/ui"}',
      'src/index.ts': "export { Dialog } from './components/Dialog';",
      'src/components/Dialog.tsx': '// A modal dialog.\nexport function Dialog() {}',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries.map((entry) => entry.topic)).toEqual(['ui.components/Dialog']);
    expect(entries[0]?.symbols).toEqual(['Dialog']);
  });

  /**
   * Module order is CODE UNITS, never `localeCompare`: this file promises that "two scans of one
   * tree agree", and `localeCompare` with no locale argument answers from the runtime's ICU default
   * and collation version — `'jobs.Cache'.localeCompare('jobs.cache')` is `1` while
   * `'jobs.Cache' < 'jobs.cache'` is `true`, so one installed tree scanned two ways on two
   * machines. Same rule `@ultimat3/jobs`' `job.ts` states for the manifest it emits.
   */
  test('module entries sort by code unit, so two scans of one tree agree', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/jobs"}',
      'src/index.ts': "export { Cache } from './Cache';\nexport { cache } from './cache';",
      'src/Cache.ts': '// The class.\nexport function Cache() {}',
      'src/cache.ts': '// The helper.\nexport function cache() {}',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries.map((entry) => entry.topic)).toEqual(['jobs.Cache', 'jobs.cache']);
  });

  test('a .ts module still wins when both spellings exist', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/ui"}',
      'src/index.ts': "export { Both } from './both';",
      'src/both.ts': '// The .ts one.\nexport function Both() {}',
      'src/both.tsx': '// The .tsx one.\nexport function Both() {}',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries[0]?.title).toBe('The .ts one.');
  });

  test('a module index.ts names but the tarball does not ship is skipped', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/jobs"}',
      'src/index.ts': "export { gone } from './gone';",
    });
    expect(await scanPackageDocs(dir)).toEqual([]);
  });

  test('`export { a as b }` indexes the public name, not the local one', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': "export { internalName as publicName } from './m';",
      'src/m.ts': '// Header.\nexport const internalName = 1;',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries[0]?.symbols).toEqual(['publicName']);
  });

  test('the header comment is the doc text, in both comment styles', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': "export { a } from './line';\nexport { b } from './block';",
      'src/line.ts':
        '// Retry policy and backoff.\n// Second line.\nimport x;\nexport const a = 1;',
      'src/block.ts': '/**\n * Block header.\n */\nexport const b = 1;',
    });
    const entries = await scanPackageDocs(dir);
    const byTopic = new Map(entries.map((entry) => [entry.topic, entry]));
    expect(byTopic.get('x.line')?.title).toBe('Retry policy and backoff.');
    expect(byTopic.get('x.line')?.text).toContain('Second line.');
    expect(byTopic.get('x.line')?.text).not.toContain('import x');
    expect(byTopic.get('x.block')?.title).toBe('Block header.');
  });

  test('a module with no header comment is still indexed by its symbols', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': "export { bare } from './bare';",
      'src/bare.ts': 'export const bare = 1;',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries[0]?.symbols).toEqual(['bare']);
    expect(entries[0]?.title).toBe('');
  });

  test('README and CLAUDE headings become guide entries pointing at the shipped file', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': '',
      'README.md': '# x\n\n## Money\n\nNever a float.\n\n## Time\n\nAlways a zone.\n',
      'CLAUDE.md': '# x — boundary\n\n## Owns\n\nThe seam.\n',
    });
    const entries = await scanPackageDocs(dir);
    const guides = entries.filter((entry) => entry.kind === 'guide');
    expect(guides.map((entry) => entry.topic)).toEqual([
      'x.README#money',
      'x.README#time',
      'x.CLAUDE#owns',
    ]);
    expect(guides[0]?.source).toBe('README.md');
    expect(guides[0]?.text).toContain('Never a float.');
    expect(guides[0]?.text).not.toContain('Always a zone.');
  });

  test('two sections with the same heading get distinct topics, so neither is shadowed', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': '',
      'README.md': '# x\n\n## Errors\n\nFirst.\n\n## Errors\n\nSecond.\n\n## Errors\n\nThird.\n',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries.map((entry) => entry.topic)).toEqual([
      'x.README#errors',
      'x.README#errors-2',
      'x.README#errors-3',
    ]);
    // The suffix follows document order, so the ids stay derived rather than arbitrary.
    expect(entries.map((entry) => entry.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  test('a heading repeated across README and CLAUDE keeps its own file in the topic', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': '',
      'README.md': '# x\n\n## Owns\n\nA.\n',
      'CLAUDE.md': '# x\n\n## Owns\n\nB.\n',
    });
    const entries = await scanPackageDocs(dir);
    expect(entries.map((entry) => entry.topic)).toEqual(['x.README#owns', 'x.CLAUDE#owns']);
  });

  test('entries are stably ordered, so two scans of one tree agree', async () => {
    const dir = fixture({
      'package.json': '{"name":"@ultimat3/x"}',
      'src/index.ts': "export { b } from './b';\nexport { a } from './a';",
      'src/a.ts': '// A.\nexport const a = 1;',
      'src/b.ts': '// B.\nexport const b = 1;',
    });
    const first = await scanPackageDocs(dir);
    const second = await scanPackageDocs(dir);
    expect(first.map((entry) => entry.topic)).toEqual(['x.a', 'x.b']);
    expect(first).toEqual(second);
  });
});

describe('unit · scanInstalledDocs', () => {
  test('a scope directory that does not exist yields nothing', async () => {
    expect(await scanInstalledDocs(join(tmpdir(), 'ultimate-docs-absent-scope'))).toEqual([]);
  });

  test('every package under the scope is scanned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultimate-scope-'));
    for (const name of ['one', 'two']) {
      mkdirSync(join(dir, name, 'src'), { recursive: true });
      writeFileSync(join(dir, name, 'package.json'), `{"name":"@ultimat3/${name}"}`);
      writeFileSync(join(dir, name, 'src/index.ts'), "export { s } from './m';");
      writeFileSync(join(dir, name, 'src/m.ts'), '// H.\nexport const s = 1;');
    }
    const entries = await scanInstalledDocs(dir);
    expect(entries.map((entry) => entry.package).sort()).toEqual([
      '@ultimat3/one',
      '@ultimat3/two',
    ]);
  });

  // `node_modules` is not a curated tree: an interrupted install leaves a truncated
  // `package.json`, and `JSON.parse` on it threw straight out of the `Promise.all`. One bad
  // directory took down the scan for every OTHER package — the docs command answered nothing,
  // for a reason that had nothing to do with the question.
  test('one unparseable package.json costs that package, not the scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultimate-scope-'));
    mkdirSync(join(dir, 'good', 'src'), { recursive: true });
    writeFileSync(join(dir, 'good', 'package.json'), '{"name":"@ultimat3/good"}');
    writeFileSync(join(dir, 'good', 'src/index.ts'), "export { s } from './m';");
    writeFileSync(join(dir, 'good', 'src/m.ts'), '// H.\nexport const s = 1;');
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'package.json'), '{"name":"@ultimat3/bro');

    const entries = await scanInstalledDocs(dir);
    expect(entries.map((entry) => entry.package)).toEqual(['@ultimat3/good']);
  });

  test('a package.json that is JSON but not an object is not a package', async () => {
    const dir = fixture({ 'package.json': '"@ultimat3/nope"' });
    expect(await scanPackageDocs(dir)).toEqual([]);
  });
});

describe('live · the installed framework', () => {
  // The scan is only worth anything if it works on the real tree, not just a fixture.
  test('@ultimat3/jobs indexes its retry module and its public symbols', async () => {
    const entries = await scanPackageDocs(join(import.meta.dir, '../../jobs'));
    const retry = entries.find((entry) => entry.topic === 'jobs.retry');
    expect(retry?.package).toBe('@ultimat3/jobs');
    expect(retry?.source).toBe('src/retry.ts');
    expect(retry?.symbols).toContain('nextRetry');
    expect(retry?.symbols).toContain('RetryPolicy');
  });
});
